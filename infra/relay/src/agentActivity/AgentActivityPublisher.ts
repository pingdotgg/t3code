import type {
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
  RelayDeliveryResult,
  RelayPublishResponse,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  isExpiredAgentActivityState,
  isTerminalPhase,
  sanitizeAgentActivityAggregateState,
} from "./agentActivityPayloads.ts";

export { isExpiredAgentActivityState } from "./agentActivityPayloads.ts";
import * as AgentActivityRows from "./AgentActivityRows.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as LiveActivities from "./LiveActivities.ts";
import * as ApnsDeliveries from "./ApnsDeliveries.ts";

export type AgentActivityPublishError =
  | AgentActivityRows.AgentActivityRowUpsertPersistenceError
  | AgentActivityRows.AgentActivityRowDeletePersistenceError
  | AgentActivityRows.AgentActivityRowListPersistenceError
  | EnvironmentLinks.EnvironmentLinkUserListPersistenceError
  | LiveActivities.LiveActivityTargetListPersistenceError
  | ApnsDeliveries.ApnsDeliveryError;

export class AgentActivityPublisher extends Context.Service<
  AgentActivityPublisher,
  {
    readonly publish: (input: {
      readonly environmentId: string;
      readonly environmentPublicKey: string;
      readonly threadId: string;
      readonly state: RelayAgentActivityState | null;
    }) => Effect.Effect<RelayPublishResponse, AgentActivityPublishError>;
    readonly replayForLiveActivityRegistration: (input: {
      readonly userId: string;
      readonly deviceId: string;
    }) => Effect.Effect<RelayDeliveryResult | null, AgentActivityPublishError>;
  }
>()("t3code-relay/agentActivity/AgentActivityPublisher") {}

export const make = Effect.gen(function* () {
  const rows = yield* AgentActivityRows.AgentActivityRows;
  const links = yield* EnvironmentLinks.EnvironmentLinks;
  const liveActivities = yield* LiveActivities.LiveActivities;
  const apnsDeliveries = yield* ApnsDeliveries.ApnsDeliveries;

  const publishForDeliveryUser = Effect.fnUntraced(function* (input: {
    readonly deliveryUser: EnvironmentLinks.AgentAwarenessDeliveryUserRecord;
    readonly state: RelayAgentActivityState | null;
    readonly nowMs: number;
  }) {
    const activeStates = yield* rows.listForUser({ userId: input.deliveryUser.userId });
    const liveActivityAggregate = input.deliveryUser.liveActivitiesEnabled
      ? makeAggregateState({
          activeStates,
          terminalState: input.state && isTerminalPhase(input.state) ? input.state : null,
          nowMs: input.nowMs,
        })
      : null;
    const notificationOnlyAggregate =
      input.deliveryUser.notificationsEnabled &&
      !input.deliveryUser.liveActivitiesEnabled &&
      input.state !== null
        ? makeAggregateState({
            activeStates: isTerminalPhase(input.state) ? [] : [input.state],
            terminalState: isTerminalPhase(input.state) ? input.state : null,
            nowMs: input.nowMs,
          })
        : null;
    const targets = yield* liveActivities.listTargets({ userId: input.deliveryUser.userId });
    const deliveriesByTarget = yield* Effect.forEach(
      targets,
      (target) =>
        Effect.all(
          [
            apnsDeliveries.sendForTarget({
              target,
              aggregate: liveActivityAggregate,
              nowMs: input.nowMs,
            }),
            notificationOnlyAggregate === null
              ? Effect.succeed(null)
              : apnsDeliveries.sendPushNotificationForTarget({
                  target,
                  aggregate: notificationOnlyAggregate,
                }),
          ],
          { concurrency: 2 },
        ),
      { concurrency: 4 },
    );
    return deliveriesByTarget.flat();
  });

  return AgentActivityPublisher.of({
    replayForLiveActivityRegistration: Effect.fn(
      "relay.agent_activity_publisher.replay_for_live_activity_registration",
    )(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.mobile.device_id": input.deviceId,
        "relay.operation": "replayForLiveActivityRegistration",
      });
      const { activeStates, targets } = yield* Effect.all(
        {
          activeStates: rows.listForUser({ userId: input.userId }),
          targets: liveActivities.listTargets({ userId: input.userId }),
        },
        { concurrency: 2 },
      );
      const target = targets.find((row) => row.device_id === input.deviceId) ?? null;
      if (target === null) {
        return null;
      }
      const now = yield* DateTime.now;
      const aggregate = makeAggregateState({
        activeStates,
        terminalState: null,
        nowMs: now.epochMilliseconds,
      });
      return yield* apnsDeliveries.sendForTarget({
        target,
        aggregate,
        nowMs: now.epochMilliseconds,
      });
    }),
    publish: Effect.fn("relay.agent_activity_publisher.publish")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": input.environmentId,
        "relay.thread_id": input.threadId,
        "relay.agent_activity.phase": input.state?.phase ?? "deleted",
      });
      if (input.state) {
        // Terminal states are persisted too (pruned by the cron after they
        // age out) so a thread that finishes while other agents are active
        // stays visible as Done/Failed in subsequent aggregates instead of
        // silently vanishing from the Live Activity.
        yield* rows.upsert({
          environmentPublicKey: input.environmentPublicKey,
          state: input.state,
        });
      } else {
        yield* rows.remove({
          environmentId: input.environmentId,
          environmentPublicKey: input.environmentPublicKey,
          threadId: input.threadId,
        });
      }

      const deliveryUsers = yield* links.listDeliveryUsersForEnvironment({
        environmentId: input.environmentId,
        environmentPublicKey: input.environmentPublicKey,
      });
      const now = yield* DateTime.now;
      const deliveriesByUser = yield* Effect.forEach(
        deliveryUsers,
        (deliveryUser) =>
          publishForDeliveryUser({
            deliveryUser,
            state: input.state,
            nowMs: now.epochMilliseconds,
          }),
        { concurrency: 4 },
      );
      const deliveries = deliveriesByUser.flat();
      return {
        ok: true,
        deliveries: deliveries.filter(
          (delivery): delivery is RelayDeliveryResult => delivery !== null,
        ),
      };
    }),
  });
});

function statusForPhase(phase: RelayAgentActivityState["phase"]): string {
  switch (phase) {
    case "waiting_for_approval":
      return "Approval";
    case "waiting_for_input":
      return "Input";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "starting":
      // Matches the web sidebar's pill wording (Sidebar.logic.ts) so the same
      // thread reads the same across surfaces.
      return "Connecting";
    case "running":
      return "Working";
    case "stale":
      return "Waiting";
  }
}

function aggregateRowForState(state: RelayAgentActivityState) {
  return {
    environmentId: state.environmentId,
    threadId: state.threadId,
    projectTitle: state.projectTitle,
    threadTitle: state.threadTitle,
    modelTitle: state.modelTitle,
    phase: state.phase,
    status: statusForPhase(state.phase),
    updatedAt: state.updatedAt,
    deepLink: state.deepLink,
  };
}

function terminalAggregateState(state: RelayAgentActivityState): RelayAgentActivityAggregateState {
  return sanitizeAgentActivityAggregateState({
    title: "T3 Code",
    subtitle: state.phase === "failed" ? "Agent work failed" : "Agent work completed",
    activeCount: 0,
    updatedAt: state.updatedAt,
    activities: [aggregateRowForState(state)],
  });
}

// How long a finished thread keeps its Done/Failed row in the aggregate while
// other agents are still active. Long enough to be seen on the lock screen,
// short enough that the activity list stays about live work.
export const TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS = 5 * 60 * 1_000;

function isRecentTerminalState(state: RelayAgentActivityState, nowMs: number): boolean {
  if (!isTerminalPhase(state)) {
    return false;
  }
  const updatedAtMs = Option.match(DateTime.make(state.updatedAt), {
    onNone: () => Number.NaN,
    onSome: (dt) => dt.epochMilliseconds,
  });
  if (Number.isNaN(updatedAtMs)) {
    return false;
  }
  return nowMs - updatedAtMs <= TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS;
}

export function makeAggregateState(input: {
  readonly activeStates: ReadonlyArray<RelayAgentActivityState>;
  readonly terminalState: RelayAgentActivityState | null;
  readonly nowMs: number;
}): RelayAgentActivityAggregateState | null {
  const activeStates = input.activeStates.filter(
    (state) => !isTerminalPhase(state) && !isExpiredAgentActivityState(state, input.nowMs),
  );
  if (activeStates.length === 0) {
    // Only the just-published terminal event ends the activity with a Done
    // aggregate; lingering terminal rows alone never do, so a replay after a
    // fresh registration doesn't resurrect a finished thread.
    return input.terminalState === null ? null : terminalAggregateState(input.terminalState);
  }
  // Recently finished threads ride along after the active ones (display slots
  // permitting) so a completion is visible as Done/Failed instead of the row
  // silently vanishing while other agents keep the activity alive.
  const recentTerminalStates = input.activeStates
    .filter((state) => isRecentTerminalState(state, input.nowMs))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const displayedStates = [...activeStates.slice(0, 3), ...recentTerminalStates].slice(0, 3);
  const updatedAt = [...activeStates, ...recentTerminalStates].reduce((latest, state) =>
    state.updatedAt.localeCompare(latest.updatedAt) > 0 ? state : latest,
  ).updatedAt;
  return sanitizeAgentActivityAggregateState({
    title: "T3 Code",
    subtitle: "Agent work in progress",
    activeCount: activeStates.length,
    updatedAt,
    activities: displayedStates.map(aggregateRowForState),
  });
}

export const layer = Layer.effect(AgentActivityPublisher, make);
