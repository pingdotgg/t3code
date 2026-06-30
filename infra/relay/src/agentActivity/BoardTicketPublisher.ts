import type {
  RelayBoardTicketState,
  RelayDeliveryResult,
  RelayPublishResponse,
} from "@t3tools/contracts/relay";
import { RelayAgentAwarenessPreferences as RelayAgentAwarenessPreferencesSchema } from "@t3tools/contracts/relay";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ApnsNotificationPayload } from "./apnsDeliveryJobs.ts";
import * as ApnsDeliveryQueue from "./ApnsDeliveryQueue.ts";
import * as LiveActivities from "./LiveActivities.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";

// Board pushes are best-effort: the needs-you inbox/RPC is the reliable browsing
// surface, so a per-user or per-device failure is logged and skipped rather than
// failing the whole publish (which would make the server retry the outbox row and
// could permanently strand every other device behind one persistent failure).
// Two errors propagate instead of being swallowed: the pre-fanout delivery-user
// lookup, and ApnsDeliveryQueueSendError (the delivery-queue transport is down for
// the whole batch — a retryable outage that is NOT a per-device opt-out). Letting
// the latter propagate makes the server's notification outbox retry the row rather
// than recording {ok:true,deliveries:[]} as terminal success and dropping every
// attention push issued during the outage.
export type BoardTicketPublishError =
  | EnvironmentLinks.EnvironmentLinkUserListPersistenceError
  | ApnsDeliveryQueue.ApnsDeliveryQueueSendError;

export interface BoardTicketPublisherShape {
  readonly publish: (input: {
    readonly environmentId: string;
    readonly environmentPublicKey: string;
    readonly boardId: string;
    readonly ticketId: string;
    readonly state: RelayBoardTicketState | null;
  }) => Effect.Effect<RelayPublishResponse, BoardTicketPublishError>;
}

export class BoardTicketPublisher extends Context.Service<
  BoardTicketPublisher,
  BoardTicketPublisherShape
>()("t3code-relay/agentActivity/BoardTicketPublisher") {}

const decodeRelayAgentAwarenessPreferencesJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(RelayAgentAwarenessPreferencesSchema),
);

// Per-target fan-out result: the enqueued delivery (or null when skipped/failed)
// plus whether the failure was a RETRYABLE infra error — a queue-transport send
// error OR a per-user target-lookup failure. Used after the fan-out to detect a
// batch-wide outage worth retrying via the server's notification outbox.
interface TargetOutcome {
  readonly delivery: RelayDeliveryResult | null;
  readonly transportFailed: boolean;
}

function isApnsDeliveryQueueSendError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    (cause as { readonly _tag: unknown })._tag === "ApnsDeliveryQueueSendError"
  );
}

function notificationAllowedForState(input: {
  readonly preferencesJson: string;
  readonly attentionKind: RelayBoardTicketState["attentionKind"];
}): boolean {
  const preferences = Option.getOrNull(
    decodeRelayAgentAwarenessPreferencesJson(input.preferencesJson),
  );
  if (!preferences?.notificationsEnabled) {
    return false;
  }
  switch (input.attentionKind) {
    case "waiting_for_approval":
      return preferences.notifyOnApproval;
    case "waiting_for_input":
      return preferences.notifyOnInput;
    case "blocked":
      return preferences.notifyOnBlocked ?? true;
    // A future WorkflowTicketAttentionKind value (the relay copy in relay.ts is a
    // manual "keep in sync" mirror) has no per-kind toggle yet. Default to
    // notifying — consistent with `blocked`'s `?? true` and so a new attention
    // kind is not silently suppressed before its preference is wired up — instead
    // of falling through to an implicit `undefined` (falsy) return.
    default:
      return true;
  }
}

const make = Effect.gen(function* () {
  const links = yield* EnvironmentLinks.EnvironmentLinks;
  const liveActivities = yield* LiveActivities.LiveActivities;
  const deliveryQueue = yield* ApnsDeliveryQueue.ApnsDeliveryQueue;
  const crypto = yield* Crypto.Crypto;

  return BoardTicketPublisher.of({
    publish: Effect.fn("relay.board_ticket_publisher.publish")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": input.environmentId,
        "relay.board_id": input.boardId,
        "relay.ticket_id": input.ticketId,
        "relay.board_ticket.attention_kind": input.state?.attentionKind ?? "cleared",
      });
      const state = input.state;
      if (state === null) {
        return { ok: true, deliveries: [] };
      }
      const notification: ApnsNotificationPayload = {
        title: state.title,
        body: state.body,
        environmentId: state.environmentId,
        boardId: state.boardId,
        ticketId: state.ticketId,
        deepLink: state.deepLink,
      };
      const deliveryUsers = yield* links.listDeliveryUsersForEnvironment({
        environmentId: input.environmentId,
        environmentPublicKey: input.environmentPublicKey,
      });
      const deliveriesByUser = yield* Effect.forEach(
        deliveryUsers,
        (deliveryUser) =>
          Effect.gen(function* () {
            // Honor the user's environment-level notification opt-out. The delivery
            // list also includes users who only enabled live activities, so this
            // filter must be per-user — not just the per-device preferences below.
            if (!deliveryUser.notificationsEnabled) {
              return [] as ReadonlyArray<TargetOutcome>;
            }
            const targets = yield* liveActivities.listTargets({ userId: deliveryUser.userId });
            const perTarget = yield* Effect.forEach(
              targets,
              (target) =>
                Effect.gen(function* () {
                  if (!target.push_token) {
                    return { delivery: null, transportFailed: false } satisfies TargetOutcome;
                  }
                  if (
                    !notificationAllowedForState({
                      preferencesJson: target.preferences_json,
                      attentionKind: state.attentionKind,
                    })
                  ) {
                    return { delivery: null, transportFailed: false } satisfies TargetOutcome;
                  }
                  // Bound the persisted dedup key: source_job_id is varchar(64). Real
                  // component ids make the raw composite 150-400 chars, which Postgres
                  // rejects (no truncation), silently dropping every notification. Hash
                  // an unambiguous serialization (colons are legal in the ids, so a
                  // plain colon-join could collide distinct tuples) into a fixed-width,
                  // still-stable key so dedup survives.
                  const composite = stableStringify({
                    environmentId: state.environmentId,
                    boardId: state.boardId,
                    ticketId: state.ticketId,
                    transitionId: state.transitionId,
                    deviceId: target.device_id,
                  });
                  const digest = yield* crypto.digest(
                    "SHA-256",
                    new TextEncoder().encode(composite),
                  );
                  const jobId = `board:${Encoding.encodeBase64Url(digest)}`;
                  const delivery = yield* deliveryQueue.enqueuePushNotification({
                    userId: target.user_id,
                    deviceId: target.device_id,
                    token: target.push_token,
                    notification,
                    jobId,
                  });
                  return { delivery, transportFailed: false } satisfies TargetOutcome;
                }).pipe(
                  // Isolate per-device failures (digest or enqueue): log and skip so
                  // one stranded device does not block its siblings. We still record
                  // whether the failure was a queue-transport error (vs a per-device
                  // issue) so a batch-wide outage — where every attempted enqueue
                  // fails and nothing gets through — can be detected after the
                  // fan-out and propagated for an outbox retry, rather than reported
                  // as a false {ok:true,deliveries:[]} terminal success.
                  Effect.catch((cause) =>
                    Effect.as(
                      Effect.logWarning("board ticket push enqueue failed", {
                        userId: deliveryUser.userId,
                        deviceId: target.device_id,
                        cause,
                      }),
                      {
                        delivery: null,
                        transportFailed: isApnsDeliveryQueueSendError(cause),
                      } satisfies TargetOutcome,
                    ),
                  ),
                ),
              { concurrency: 2 },
            );
            return perTarget;
          }).pipe(
            // Isolate per-user failures (e.g. a transient listTargets/persistence
            // error) — but mark this user's whole fan-out as a retryable failure
            // (transportFailed) rather than swallowing it to an empty []. Without
            // this, a target-lookup failure looked identical to "user has no
            // devices", so a batch-wide lookup outage produced a false
            // {ok:true,deliveries:[]} terminal success and the server outbox never
            // retried. A single user's lookup failure when others succeed still
            // stays best-effort (the outage check below only retries when NOTHING
            // was delivered).
            Effect.catch((cause) =>
              Effect.as(
                Effect.logWarning("board ticket push fan-out failed for user", {
                  userId: deliveryUser.userId,
                  cause,
                }),
                [{ delivery: null, transportFailed: true }] as ReadonlyArray<TargetOutcome>,
              ),
            ),
          ),
        { concurrency: 4 },
      );
      const outcomes = deliveriesByUser.flat();
      const deliveries = outcomes
        .map((outcome) => outcome.delivery)
        .filter((delivery): delivery is RelayDeliveryResult => delivery !== null);
      // A batch-wide queue-transport outage is the one mechanical failure worth a
      // retry: every attempted enqueue failed with a transport error AND nothing
      // got through. Distinguish it from the benign all-opted-out case (no transport
      // failures) and from a single stranded device (some delivery succeeded) so we
      // only fail — and trigger the server's outbox retry — when the whole publish
      // was lost to the outage. A partial success stays best-effort, as before.
      if (deliveries.length === 0 && outcomes.some((outcome) => outcome.transportFailed)) {
        return yield* new ApnsDeliveryQueue.ApnsDeliveryQueueSendError({
          operation: "send",
          jobId: null,
          kind: "push_notification",
          userId: "",
          deviceId: "",
          cause: new Error("board ticket push fan-out failed: delivery queue unavailable"),
        });
      }
      return { ok: true, deliveries };
    }),
  });
});

export const layer = Layer.effect(BoardTicketPublisher, make);
