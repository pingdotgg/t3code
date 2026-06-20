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

import { sanitizeAgentActivityAggregateState } from "./agentActivityPayloads.ts";
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
        })
      : null;
    const notificationOnlyAggregate =
      input.deliveryUser.notificationsEnabled &&
      !input.deliveryUser.liveActivitiesEnabled &&
      input.state !== null
        ? makeAggregateState({
            activeStates: isTerminalPhase(input.state) ? [] : [input.state],
            terminalState: isTerminalPhase(input.state) ? input.state : null,
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
      const aggregate = makeAggregateState({ activeStates, terminalState: null });
      const now = yield* DateTime.now;
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
      if (input.state && !isTerminalPhase(input.state)) {
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
      return "Starting";
    case "running":
      return "Working";
    case "stale":
      return "Waiting";
  }
}

function isTerminalPhase(state: RelayAgentActivityState): boolean {
  return state.phase === "completed" || state.phase === "failed";
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
    title: "more Code",
    subtitle: state.phase === "failed" ? "Agent work failed" : "Agent work completed",
    activeCount: 0,
    updatedAt: state.updatedAt,
    activities: [aggregateRowForState(state)],
  });
}

function makeAggregateState(input: {
  readonly activeStates: ReadonlyArray<RelayAgentActivityState>;
  readonly terminalState: RelayAgentActivityState | null;
}): RelayAgentActivityAggregateState | null {
  const activeStates = input.activeStates.filter((state) => !isTerminalPhase(state));
  if (activeStates.length === 0) {
    return input.terminalState === null ? null : terminalAggregateState(input.terminalState);
  }
  const updatedAt = activeStates.reduce((latest, state) =>
    state.updatedAt.localeCompare(latest.updatedAt) > 0 ? state : latest,
  ).updatedAt;
  return sanitizeAgentActivityAggregateState({
    title: "more Code",
    subtitle: "Agent work in progress",
    activeCount: activeStates.length,
    updatedAt,
    activities: activeStates.slice(0, 3).map(aggregateRowForState),
  });
}

export const layer = Layer.effect(AgentActivityPublisher, make);
