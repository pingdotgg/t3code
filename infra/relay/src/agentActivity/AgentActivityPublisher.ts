import {
  makeAggregateState,
  TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS,
} from "./agentActivityAggregate.ts";
export {
  makeAggregateState,
  TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS,
} from "./agentActivityAggregate.ts";
import type {
  RelayAgentActivityState,
  RelayDeliveryResult,
  RelayPublishResponse,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { isTerminalPhase } from "./agentActivityPayloads.ts";

export { isExpiredAgentActivityState } from "./agentActivityPayloads.ts";
import * as AgentActivityRows from "./AgentActivityRows.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as LiveActivities from "./LiveActivities.ts";
import * as ApnsDeliveries from "./ApnsDeliveries.ts";
import * as FcmDeliveries from "./FcmDeliveries.ts";

export type AgentActivityPublishError =
  | FcmDeliveries.FcmDeliveryError
  | AgentActivityRows.AgentActivityRowUpsertPersistenceError
  | AgentActivityRows.AgentActivityRowDeletePersistenceError
  | AgentActivityRows.AgentActivityRowListPersistenceError
  | EnvironmentLinks.EnvironmentLinkUserListPersistenceError
  | LiveActivities.LiveActivityTargetListPersistenceError
  | LiveActivities.LiveActivityIdleTargetListPersistenceError
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
    readonly endIdleLiveActivities: (input: {
      readonly nowMs: number;
    }) => Effect.Effect<void, AgentActivityPublishError>;
  }
>()("t3code-relay/agentActivity/AgentActivityPublisher") {}

export const make = Effect.gen(function* () {
  const rows = yield* AgentActivityRows.AgentActivityRows;
  const links = yield* EnvironmentLinks.EnvironmentLinks;
  const liveActivities = yield* LiveActivities.LiveActivities;
  const apnsDeliveries = yield* ApnsDeliveries.ApnsDeliveries;
  const fcmDeliveries = yield* FcmDeliveries.FcmDeliveries;

  const publishForDeliveryUser = Effect.fnUntraced(function* (input: {
    readonly deliveryUser: EnvironmentLinks.AgentAwarenessDeliveryUserRecord;
    readonly state: RelayAgentActivityState | null;
    readonly nowMs: number;
  }) {
    const activeStates = input.deliveryUser.liveActivitiesEnabled
      ? yield* rows.listForUser({ userId: input.deliveryUser.userId })
      : [];
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
      Effect.fnUntraced(function* (target) {
        if (target.platform === "android") {
          return [yield* fcmDeliveries.enqueue({ target, state: input.state })];
        }
        return yield* Effect.all(
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
        );
      }),
      { concurrency: 4 },
    );
    return deliveriesByTarget.flat();
  });

  // Silently re-delivers the current aggregate to one device: repaints drifted
  // content, or ends the card when nothing is left to show. With `endOnly`
  // the content is never repainted: a silent repaint would make the real
  // publish for that same state look unchanged and swallow its alert.
  const replayForTarget = Effect.fnUntraced(function* (input: {
    readonly userId: string;
    readonly deviceId: string;
    readonly endOnly?: boolean;
  }) {
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
    if (target.platform === "android") {
      return input.endOnly
        ? null
        : yield* fcmDeliveries.enqueue({ target, state: null, replay: true });
    }
    const now = yield* DateTime.now;
    const aggregate = makeAggregateState({
      activeStates,
      terminalState: null,
      nowMs: now.epochMilliseconds,
    });
    if (input.endOnly && aggregate !== null) {
      return null;
    }
    return yield* apnsDeliveries.sendForTarget({
      target,
      aggregate,
      nowMs: now.epochMilliseconds,
      replay: true,
    });
  });

  return AgentActivityPublisher.of({
    replayForLiveActivityRegistration: Effect.fn(
      "relay.agent_activity_publisher.replay_for_live_activity_registration",
    )(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.mobile.device_id": input.deviceId,
        "relay.operation": "replayForLiveActivityRegistration",
      });
      return yield* replayForTarget({ userId: input.userId, deviceId: input.deviceId });
    }),
    // Deliveries only happen when an environment publishes or the app
    // re-registers, so a card left showing finished work would otherwise keep
    // its Done rows past the display window until one of those happens.
    // Replaying the aggregate once the window has passed ends it.
    endIdleLiveActivities: Effect.fn("relay.agent_activity_publisher.end_idle_live_activities")(
      function* (input) {
        const deliveredBefore = DateTime.formatIso(
          DateTime.makeUnsafe(input.nowMs - TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS),
        );
        const targets = yield* liveActivities.listIdleArmedTargets({ deliveredBefore });
        yield* Effect.annotateCurrentSpan({ "relay.live_activities.idle_count": targets.length });
        yield* Effect.forEach(
          targets,
          (target) =>
            replayForTarget({
              userId: target.user_id,
              deviceId: target.device_id,
              endOnly: true,
            }).pipe(
              Effect.tapError((error) =>
                Effect.logWarning("idle live activity replay failed", {
                  deviceId: target.device_id,
                  errorTag: error._tag,
                }),
              ),
              Effect.ignore,
            ),
          { concurrency: 4, discard: true },
        );
      },
    ),
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

export const layer = Layer.effect(AgentActivityPublisher, make);
