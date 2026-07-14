import type {
  RelayAgentActivityAggregateState,
  RelayDeliveryResult,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { parseAgentAwarenessPreferences } from "./agentAwarenessPreferences.ts";
import {
  freshNewlyTerminalRows,
  newlyAttentionRows,
  parseAggregate,
  shouldUpdateLiveActivity,
} from "./agentActivityTransitions.ts";
import * as DeliveryAttempts from "./DeliveryAttempts.ts";
import * as Devices from "./Devices.ts";
import * as ExpoPush from "./ExpoPushClient.ts";
import * as LiveActivities from "./LiveActivities.ts";

const STATUS_NOTIFICATION_TAG = "t3-connect-agent-status";
const STATUS_COLLAPSE_ID = "t3-connect-agent-status";
const ALERT_NOTIFICATION_TAG = "t3-connect-agent-alert";
const ALERT_COLLAPSE_ID = "t3-connect-agent-alert";
export const ANDROID_ACTIVITY_CHANNEL_ID = "t3-connect-activity";
export const ANDROID_ALERTS_CHANNEL_ID = "t3-connect-alerts";

export interface AndroidTargetMessages {
  // Quiet replaceable shade content on the activity channel.
  readonly status: ExpoPush.ExpoPushMessage | null;
  // High-priority sounding notification on the alerts channel; only ever
  // non-null for a state *transition* against the last delivered aggregate.
  readonly alert: ExpoPush.ExpoPushMessage | null;
  // The aggregate drifted but nothing was worth sending (no status channel
  // active). The stored baseline must still advance, or a thread that leaves
  // and later re-enters an attention phase would never alert again.
  readonly baselineRefresh: boolean;
}

const NO_MESSAGES: AndroidTargetMessages = { status: null, alert: null, baselineRefresh: false };

// Decides what an Android publish delivers. Mirrors the iOS rules: alerts ring
// only on attention/terminal transitions computed against the per-device
// last-delivered aggregate (a null baseline never rings — that is a reconnect,
// not a transition), terminal alerts require freshness so replays stay silent,
// and the quiet status update is deduplicated and throttled. When an alert
// fires while the status channel is enabled, the status message rides along so
// the shade never shows stale running content beside a completion alert.
export function messagesForAndroidTarget(input: {
  readonly target: LiveActivities.TargetRow;
  readonly aggregate: RelayAgentActivityAggregateState | null;
  readonly nowMs: number;
}): AndroidTargetMessages {
  const expoPushToken = input.target.expo_push_token;
  if (input.target.platform !== "android" || !expoPushToken) {
    return NO_MESSAGES;
  }
  const preferences = parseAgentAwarenessPreferences(input.target.preferences_json);
  if (!preferences) {
    return NO_MESSAGES;
  }
  const previousAggregate = parseAggregate(input.target.last_aggregate_json);

  let alert: ExpoPush.ExpoPushMessage | null = null;
  if (input.aggregate !== null && preferences.notificationsEnabled) {
    const attention = newlyAttentionRows({
      previousAggregate,
      nextAggregate: input.aggregate,
      preferences,
    });
    const rows =
      attention.length > 0
        ? attention
        : freshNewlyTerminalRows({
            previousAggregate,
            nextAggregate: input.aggregate,
            preferences,
            nowMs: input.nowMs,
          });
    const first = rows[0];
    if (first) {
      alert = {
        to: expoPushToken,
        title:
          rows.length === 1
            ? first.threadTitle
            : attention.length > 0
              ? `${rows.length} agents need attention`
              : `${rows.length} agents finished`,
        body:
          rows.length === 1
            ? `${first.status}: ${first.projectTitle}`
            : rows.map((row) => row.threadTitle).join(", "),
        data: {
          environmentId: first.environmentId,
          threadId: first.threadId,
          deepLink: first.deepLink,
          notificationKind: "agent-awareness",
        },
        channelId: ANDROID_ALERTS_CHANNEL_ID,
        tag: ALERT_NOTIFICATION_TAG,
        collapseId: ALERT_COLLAPSE_ID,
        priority: "high",
        sound: "default",
      };
    }
  }

  let status: ExpoPush.ExpoPushMessage | null = null;
  if (preferences.liveActivitiesEnabled) {
    if (input.aggregate === null) {
      // Only the transition to "nothing left" repaints the shade; repeated
      // empty publishes stay silent.
      if (previousAggregate !== null) {
        status = {
          to: expoPushToken,
          title: "T3 Code",
          body: "No active agents",
          data: { notificationKind: "agent-awareness" },
          channelId: ANDROID_ACTIVITY_CHANNEL_ID,
          tag: STATUS_NOTIFICATION_TAG,
          collapseId: STATUS_COLLAPSE_ID,
          priority: "default",
        };
      }
    } else {
      const activity = input.aggregate.activities[0];
      if (
        activity &&
        shouldUpdateLiveActivity({
          previousAggregate,
          nextAggregate: input.aggregate,
          lastDeliveryAt: input.target.last_live_activity_delivery_at,
          nowMs: input.nowMs,
        })
      ) {
        status = {
          to: expoPushToken,
          title: input.aggregate.title,
          body:
            input.aggregate.activeCount > 1
              ? `${input.aggregate.activeCount} agents active · ${activity.threadTitle}`
              : `${activity.status}: ${activity.threadTitle} · ${activity.projectTitle}`,
          data: {
            environmentId: activity.environmentId,
            threadId: activity.threadId,
            deepLink: activity.deepLink,
            notificationKind: "agent-awareness",
          },
          channelId: ANDROID_ACTIVITY_CHANNEL_ID,
          tag: STATUS_NOTIFICATION_TAG,
          collapseId: STATUS_COLLAPSE_ID,
          priority: "default",
        };
      }
    }
  }

  // With the status channel disabled nothing repaints the baseline, so it
  // advances silently on drift; with the channel enabled the baseline moves
  // only on real deliveries, matching iOS.
  const baselineRefresh =
    status === null &&
    alert === null &&
    !preferences.liveActivitiesEnabled &&
    JSON.stringify(previousAggregate) !== JSON.stringify(input.aggregate);

  return { status, alert, baselineRefresh };
}

export type ExpoPushDeliveryError =
  | DeliveryAttempts.DeliveryAttemptRecordPersistenceError
  | LiveActivities.LiveActivityDeliveryMarkPersistenceError;

export class ExpoPushDeliveries extends Context.Service<
  ExpoPushDeliveries,
  {
    readonly sendForTarget: (input: {
      readonly target: LiveActivities.TargetRow;
      readonly aggregate: RelayAgentActivityAggregateState | null;
      readonly nowMs: number;
    }) => Effect.Effect<ReadonlyArray<RelayDeliveryResult>, ExpoPushDeliveryError>;
    readonly reconcileReceipts: Effect.Effect<void, ExpoPushDeliveryError>;
  }
>()("t3code-relay/agentActivity/ExpoPushDeliveries") {}

export const make = Effect.gen(function* () {
  const client = yield* ExpoPush.ExpoPushClient;
  const attempts = yield* DeliveryAttempts.DeliveryAttempts;
  const devices = yield* Devices.Devices;
  const liveActivities = yield* LiveActivities.LiveActivities;

  const sendMessage = Effect.fnUntraced(function* (input: {
    readonly target: LiveActivities.TargetRow;
    readonly message: ExpoPush.ExpoPushMessage;
  }) {
    const ticket = yield* client.send(input.message).pipe(
      Effect.catch((error) =>
        Effect.logError(error.message).pipe(
          Effect.annotateLogs({
            error,
            "relay.mobile.device_id": input.target.device_id,
            "relay.delivery.provider": "expo",
          }),
          Effect.as({
            ok: false,
            id: null,
            status: "transport_error",
            reason: error.message,
            errorCode: null,
          } satisfies ExpoPush.ExpoPushTicket),
        ),
      ),
    );
    const reason = ticket.errorCode ?? ticket.reason;
    yield* attempts.record({
      userId: input.target.user_id,
      environmentId: input.message.data.environmentId ?? null,
      threadId: input.message.data.threadId ?? null,
      deviceId: input.target.device_id,
      kind: "push_notification",
      token: input.message.to,
      deliveryProvider: "expo",
      providerStatus: ticket.status,
      ...(reason ? { providerReason: reason } : {}),
      providerId: ticket.id,
      ...(ticket.ok ? {} : { transportError: reason ?? "Expo rejected the push ticket." }),
    });
    if (ticket.errorCode === "DeviceNotRegistered") {
      yield* devices
        .invalidateExpoPushToken({
          userId: input.target.user_id,
          deviceId: input.target.device_id,
          expoPushToken: input.message.to,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not invalidate a rejected Expo push token.").pipe(
              Effect.annotateLogs({ error }),
            ),
          ),
        );
    }
    return {
      deviceId: input.target.device_id,
      kind: "push_notification" as const,
      ok: ticket.ok,
      queued: ticket.ok,
      apnsStatus: null,
      apnsReason: null,
      apnsId: null,
      provider: "expo" as const,
      providerStatus: ticket.status,
      providerReason: reason,
      providerId: ticket.id,
    };
  });

  return ExpoPushDeliveries.of({
    reconcileReceipts: Effect.gen(function* () {
      const now = yield* DateTime.now;
      const pending = yield* attempts.listPendingExpoReceipts({
        createdAfter: DateTime.formatIso(DateTime.subtract(now, { hours: 24 })),
        createdBefore: DateTime.formatIso(DateTime.subtract(now, { minutes: 15 })),
        limit: 1_000,
      });
      if (pending.length === 0) return;

      const receipts = yield* client
        .getReceipts(pending.map((item) => item.providerId))
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              "Could not read Expo push receipts; the next cron run will retry.",
            ).pipe(Effect.annotateLogs({ error }), Effect.as(null)),
          ),
        );
      if (receipts === null) return;

      yield* Effect.forEach(
        pending,
        (item) => {
          const receipt = receipts[item.providerId];
          if (receipt === undefined) return Effect.void;
          const reason = receipt.errorCode ?? receipt.reason;
          return attempts
            .completeExpoReceipt({
              providerId: item.providerId,
              status: receipt.status,
              reason,
            })
            .pipe(
              Effect.andThen(
                receipt.errorCode === "DeviceNotRegistered" &&
                  item.userId !== null &&
                  item.deviceId !== null &&
                  item.tokenSuffix !== null
                  ? devices
                      .invalidateExpoPushTokenSuffix({
                        userId: item.userId,
                        deviceId: item.deviceId,
                        tokenSuffix: item.tokenSuffix,
                      })
                      .pipe(
                        Effect.catch((error) =>
                          Effect.logWarning(
                            "Could not invalidate an Expo token rejected by a receipt.",
                          ).pipe(Effect.annotateLogs({ error })),
                        ),
                      )
                  : Effect.void,
              ),
            );
        },
        { concurrency: 8, discard: true },
      );
    }),
    sendForTarget: Effect.fn("relay.expo_push_deliveries.send_for_target")(function* (input) {
      const { status, alert, baselineRefresh } = messagesForAndroidTarget(input);

      yield* Effect.annotateCurrentSpan({
        "relay.mobile.device_id": input.target.device_id,
        "relay.delivery.kind": "push_notification",
        "relay.delivery.provider": "expo",
      });

      const statusResult =
        status === null ? null : yield* sendMessage({ target: input.target, message: status });
      const alertResult =
        alert === null ? null : yield* sendMessage({ target: input.target, message: alert });
      const results: Array<RelayDeliveryResult> = [];
      if (statusResult !== null) results.push(statusResult);
      if (alertResult !== null) results.push(alertResult);

      // The baseline is the alert-transition reference: it advances on an
      // accepted delivery, and silently on drift when no status channel would
      // repaint it. A failed alert must keep the old baseline even when the
      // quiet status went through — advancing it would consume the transition
      // and the missed ring would never retry on the next publish.
      const delivered = results.some((result) => result.ok);
      const alertSatisfied = alert === null || alertResult?.ok === true;
      if ((delivered && alertSatisfied) || baselineRefresh) {
        const now = yield* DateTime.now;
        yield* liveActivities.markDelivery({
          userId: input.target.user_id,
          deviceId: input.target.device_id,
          kind: "push_notification",
          aggregate: input.aggregate,
          deliveredAt: DateTime.formatIso(now),
        });
      }
      return results;
    }),
  });
});

export const layer = Layer.effect(ExpoPushDeliveries, make);
