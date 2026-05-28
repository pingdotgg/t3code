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

import { sanitizeAgentActivityAggregateState } from "../agentActivityPayloads.ts";
import {
  increment,
  relayAgentActivityPublishesTotal,
  relayApnsDeliveriesTotal,
} from "../observability/Metrics.ts";
import * as AgentActivityRows from "../persistence/AgentActivityRows.ts";
import * as EnvironmentLinks from "../persistence/EnvironmentLinks.ts";
import * as LiveActivities from "../persistence/LiveActivities.ts";
import * as ApnsDeliveries from "./ApnsDeliveries.ts";

export type AgentActivityPublishError =
  | AgentActivityRows.AgentActivityRowUpsertPersistenceError
  | AgentActivityRows.AgentActivityRowDeletePersistenceError
  | AgentActivityRows.AgentActivityRowListPersistenceError
  | EnvironmentLinks.EnvironmentLinkUserListPersistenceError
  | LiveActivities.LiveActivityTargetListPersistenceError
  | ApnsDeliveries.ApnsDeliveryError;

export interface AgentActivityPublisherShape {
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

export class AgentActivityPublisher extends Context.Service<
  AgentActivityPublisher,
  AgentActivityPublisherShape
>()("AgentActivityPublisher") {}

const make = Effect.gen(function* () {
  const rows = yield* AgentActivityRows.AgentActivityRows;
  const links = yield* EnvironmentLinks.EnvironmentLinks;
  const liveActivities = yield* LiveActivities.LiveActivities;
  const apnsDeliveries = yield* ApnsDeliveries.ApnsDeliveries;

  return AgentActivityPublisher.of({
    replayForLiveActivityRegistration: Effect.fn(
      "relay.agent_activity_publisher.replay_for_live_activity_registration",
    )(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.mobile.device_id": input.deviceId,
        "relay.operation": "replayForLiveActivityRegistration",
      });
      const activeStates = yield* rows.listForUser({ userId: input.userId });
      const targets = yield* liveActivities.listTargets({ userId: input.userId });
      const target = targets.find((row) => row.device_id === input.deviceId) ?? null;
      if (target === null) {
        yield* increment(relayAgentActivityPublishesTotal, {
          operation: "replay",
          outcome: "no_target",
        });
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
          Effect.gen(function* () {
            const activeStates = yield* rows.listForUser({ userId: deliveryUser.userId });
            const liveActivityAggregate = deliveryUser.liveActivitiesEnabled
              ? makeAggregateState({
                  activeStates,
                  terminalState: input.state && isTerminalPhase(input.state) ? input.state : null,
                })
              : null;
            const notificationOnlyAggregate =
              deliveryUser.notificationsEnabled &&
              !deliveryUser.liveActivitiesEnabled &&
              input.state !== null
                ? makeAggregateState({
                    activeStates: isTerminalPhase(input.state) ? [] : [input.state],
                    terminalState: isTerminalPhase(input.state) ? input.state : null,
                  })
                : null;
            const targets = yield* liveActivities.listTargets({ userId: deliveryUser.userId });
            const deliveriesByTarget = yield* Effect.forEach(
              targets,
              (target) =>
                Effect.all(
                  [
                    apnsDeliveries.sendForTarget({
                      target,
                      aggregate: liveActivityAggregate,
                      nowMs: now.epochMilliseconds,
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
          }),
        { concurrency: 4 },
      );
      const deliveries = deliveriesByUser.flat();
      yield* increment(relayAgentActivityPublishesTotal, {
        operation: "publish",
        phase: input.state?.phase ?? "deleted",
      });
      yield* increment(
        relayApnsDeliveriesTotal,
        { operation: "selected", source: "agent_activity_publish" },
        deliveries.filter((delivery) => delivery !== null).length,
      );
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
    title: "T3 Code",
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
    title: "T3 Code",
    subtitle: "Agent work in progress",
    activeCount: activeStates.length,
    updatedAt,
    activities: activeStates.slice(0, 3).map(aggregateRowForState),
  });
}

export const layer = Layer.effect(AgentActivityPublisher, make);
