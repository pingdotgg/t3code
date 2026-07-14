import type {
  RelayAgentActivityAggregateState,
  RelayAgentAwarenessPreferences,
  RelayDeliveryKind,
  RelayDeliveryResult,
} from "@t3tools/contracts/relay";
import {
  RelayAgentActivityAggregateState as RelayAgentActivityAggregateStateSchema,
  RelayAgentAwarenessPreferences as RelayAgentAwarenessPreferencesSchema,
  RelayDeliveryKind as RelayDeliveryKindSchema,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import {
  isExpiredAgentActivityState,
  isTerminalPhase,
  sanitizeAgentActivityAggregateState,
  sanitizeApnsNotificationPayload,
} from "./agentActivityPayloads.ts";
import * as Apns from "./ApnsClient.ts";
import {
  ApnsDeliveryJobLiveActivityAggregateMissing,
  ApnsDeliveryJobPushNotificationMissing,
  ApnsDeliveryJobQueuePayloadInvalid,
  type ApnsLiveActivityAlert,
  type ApnsNotificationPayload,
  SignedApnsDeliveryJob,
  isApnsDeliveryJobVerificationError,
  verifySignedApnsDeliveryJob,
  type ApnsDeliveryJobVerificationError,
} from "./apnsDeliveryJobs.ts";
import * as AgentActivityRows from "./AgentActivityRows.ts";
import * as DeliveryAttempts from "./DeliveryAttempts.ts";
import * as LiveActivities from "./LiveActivities.ts";
import * as RelayConfiguration from "../Config.ts";
import * as ApnsDeliveryQueue from "./ApnsDeliveryQueue.ts";
import { withSpanAttributes } from "../observability.ts";

const MIN_LIVE_ACTIVITY_UPDATE_INTERVAL_MS = 15_000;
// How long a just-armed card may sit with an empty aggregate before an end is
// warranted; covers the gap between arming on send and the environment's
// first publish reaching the relay.
const FRESHLY_ARMED_GRACE_MS = 2 * 60 * 1_000;
const PERMANENT_APNS_TOKEN_REASONS = new Set([
  "BadDeviceToken",
  "DeviceTokenNotForTopic",
  "Unregistered",
]);

type LiveActivityDeliveryKind = Extract<
  RelayDeliveryKind,
  "live_activity_start" | "live_activity_update" | "live_activity_end"
>;

type ChosenLiveActivityDelivery =
  | {
      readonly kind: "live_activity_start" | "live_activity_update";
      readonly token: string;
      readonly aggregate: RelayAgentActivityAggregateState;
      readonly alert: ApnsLiveActivityAlert | null;
    }
  | {
      readonly kind: "live_activity_end";
      readonly token: string;
      readonly aggregate: RelayAgentActivityAggregateState | null;
      readonly alert: ApnsLiveActivityAlert | null;
    };

type ChosenPushNotificationDelivery = {
  readonly kind: "push_notification";
  readonly token: string;
  readonly notification: ApnsNotificationPayload;
};

type ChosenDelivery = ChosenLiveActivityDelivery | ChosenPushNotificationDelivery;

export type ApnsDeliveryError =
  | ApnsDeliveryQueue.ApnsDeliveryQueueError
  | ApnsDeliveryJobVerificationError
  | ApnsDeliveryJobClaimInFlight
  | DeliveryAttempts.DeliveryAttemptRecordPersistenceError
  | LiveActivities.LiveActivityTargetListPersistenceError
  | LiveActivities.LiveActivityDeliveryMarkPersistenceError;

export class ApnsDeliveryJobClaimInFlight extends Schema.TaggedErrorClass<ApnsDeliveryJobClaimInFlight>()(
  "ApnsDeliveryJobClaimInFlight",
  {
    sourceJobId: Schema.String,
  },
) {
  override get message(): string {
    return `APNs delivery job '${this.sourceJobId}' is already in flight`;
  }
}

export class ApnsDeliveryTransportError extends Schema.TaggedErrorClass<ApnsDeliveryTransportError>()(
  "ApnsDeliveryTransportError",
  {
    deviceId: Schema.String,
    kind: RelayDeliveryKindSchema,
    sourceJobId: Schema.NullOr(Schema.String),
    apnsErrorTag: Schema.Literals([
      "ApnsJwtEncodingError",
      "ApnsJwtSigningError",
      "ApnsHttpRequestError",
    ]),
    requestStage: Schema.NullOr(Schema.Literals(["send", "read-response"])),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `APNs ${this.kind} delivery failed for device ${this.deviceId}.`;
  }
}

export const isApnsDeliveryTransportError = Schema.is(ApnsDeliveryTransportError);

const decodeRelayAgentActivityAggregateStateJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(RelayAgentActivityAggregateStateSchema),
);
const decodeRelayAgentAwarenessPreferencesJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(RelayAgentAwarenessPreferencesSchema),
);
const decodeSignedApnsDeliveryJob = Schema.decodeUnknownEffect(SignedApnsDeliveryJob);

function parseAggregate(value: string | null): RelayAgentActivityAggregateState | null {
  if (!value) {
    return null;
  }
  return Option.getOrNull(decodeRelayAgentActivityAggregateStateJson(value));
}

function parsePreferences(value: string): RelayAgentAwarenessPreferences | null {
  return Option.getOrNull(decodeRelayAgentAwarenessPreferencesJson(value));
}

function aggregateNeedsAttention(aggregate: RelayAgentActivityAggregateState): boolean {
  return aggregate.activities.some(
    (row) => row.phase === "waiting_for_approval" || row.phase === "waiting_for_input",
  );
}

function isAttentionPhase(phase: string): boolean {
  return phase === "waiting_for_approval" || phase === "waiting_for_input";
}

// Honors the same per-event notification switches the push channel uses; a
// missing/corrupt preferences blob only disables nothing (matching how the
// liveActivitiesEnabled check treats it), since every registration writes one.
function alertAllowedForPhase(
  preferences: RelayAgentAwarenessPreferences | null,
  phase: string,
): boolean {
  if (preferences === null) {
    return true;
  }
  switch (phase) {
    case "waiting_for_approval":
      return preferences.notifyOnApproval;
    case "waiting_for_input":
      return preferences.notifyOnInput;
    case "completed":
      return preferences.notifyOnCompletion;
    case "failed":
      return preferences.notifyOnFailure;
    default:
      return false;
  }
}

// Alert copy for an update whose aggregate contains threads that were NOT in an
// attention phase in the previously delivered aggregate. A null previous
// aggregate means there is no known baseline (fresh registration, replay after
// data loss) — alerting there would buzz on reconnect, not on a transition.
export function alertForAttentionTransition(input: {
  readonly previousAggregate: RelayAgentActivityAggregateState | null;
  readonly nextAggregate: RelayAgentActivityAggregateState;
  readonly preferences: RelayAgentAwarenessPreferences | null;
}): ApnsLiveActivityAlert | null {
  if (input.previousAggregate === null) {
    return null;
  }
  const previouslyAttention = new Set(
    input.previousAggregate.activities
      .filter((row) => isAttentionPhase(row.phase))
      .map((row) => row.threadId),
  );
  const newlyAttention = input.nextAggregate.activities.filter(
    (row) =>
      isAttentionPhase(row.phase) &&
      !previouslyAttention.has(row.threadId) &&
      alertAllowedForPhase(input.preferences, row.phase),
  );
  const first = newlyAttention[0];
  if (!first) {
    return null;
  }
  if (newlyAttention.length === 1) {
    return { title: first.threadTitle, body: `${first.status}: ${first.projectTitle}` };
  }
  return {
    title: `${newlyAttention.length} agents need attention`,
    body: newlyAttention.map((row) => row.threadTitle).join(", "),
  };
}

// Alert copy for an update whose aggregate contains threads that finished
// (Done/Failed) since the previously delivered aggregate — the mid-flight
// completion buzz while other agents keep the activity alive. Requires the
// thread to have been present and non-terminal before, so a baseline-less
// replay or a row that merely fell off the display cap never rings.
function newlyTerminalRows(
  previousAggregate: RelayAgentActivityAggregateState | null,
  nextAggregate: RelayAgentActivityAggregateState,
): ReadonlyArray<RelayAgentActivityAggregateState["activities"][number]> {
  if (previousAggregate === null) {
    return [];
  }
  const previousPhases = new Map(
    previousAggregate.activities.map((row) => [row.threadId, row.phase]),
  );
  return nextAggregate.activities.filter((row) => {
    if (row.phase !== "completed" && row.phase !== "failed") {
      return false;
    }
    const previousPhase = previousPhases.get(row.threadId);
    return (
      previousPhase !== undefined && previousPhase !== "completed" && previousPhase !== "failed"
    );
  });
}

function isFreshTerminalRow(
  row: RelayAgentActivityAggregateState["activities"][number],
  nowMs: number,
): boolean {
  const updatedAtMs = Option.match(DateTime.make(row.updatedAt), {
    onNone: () => null,
    onSome: (dt) => dt.epochMilliseconds,
  });
  return updatedAtMs !== null && nowMs - updatedAtMs <= TERMINAL_NOTIFICATION_FRESHNESS_MS;
}

export function alertForNewlyTerminal(input: {
  readonly previousAggregate: RelayAgentActivityAggregateState | null;
  readonly nextAggregate: RelayAgentActivityAggregateState;
  readonly preferences: RelayAgentAwarenessPreferences | null;
  readonly nowMs: number;
}): ApnsLiveActivityAlert | null {
  const newlyTerminal = newlyTerminalRows(input.previousAggregate, input.nextAggregate).filter(
    (row) =>
      alertAllowedForPhase(input.preferences, row.phase) &&
      // Replays of old aggregates (server restarts, redeliveries) repaint
      // state without ringing; only fresh completions buzz.
      isFreshTerminalRow(row, input.nowMs),
  );
  const first = newlyTerminal[0];
  if (!first) {
    return null;
  }
  if (newlyTerminal.length === 1) {
    return { title: first.threadTitle, body: `${first.status}: ${first.projectTitle}` };
  }
  return {
    title: `${newlyTerminal.length} agents finished`,
    body: newlyTerminal.map((row) => row.threadTitle).join(", "),
  };
}

// Alert copy for an end event carrying a terminal (Done/Failed) aggregate.
export function alertForTerminalAggregate(input: {
  readonly aggregate: RelayAgentActivityAggregateState | null;
  readonly preferences: RelayAgentAwarenessPreferences | null;
}): ApnsLiveActivityAlert | null {
  const row = input.aggregate?.activities[0];
  if (!row || (row.phase !== "completed" && row.phase !== "failed")) {
    return null;
  }
  if (!alertAllowedForPhase(input.preferences, row.phase)) {
    return null;
  }
  return { title: row.threadTitle, body: `${row.status}: ${row.projectTitle}` };
}

function shouldUpdateLiveActivity(input: {
  readonly previousAggregate: RelayAgentActivityAggregateState | null;
  readonly nextAggregate: RelayAgentActivityAggregateState;
  readonly lastDeliveryAt: string | null;
  readonly nowMs: number;
}): boolean {
  if (!input.previousAggregate) {
    return true;
  }
  if (JSON.stringify(input.previousAggregate) === JSON.stringify(input.nextAggregate)) {
    return false;
  }
  if (input.previousAggregate.activeCount !== input.nextAggregate.activeCount) {
    return true;
  }
  if (aggregateNeedsAttention(input.nextAggregate)) {
    return true;
  }
  // A thread finishing must never be throttled away: when a completion and a
  // new start land in the same window, activeCount is unchanged and the Done
  // transition (and its alert) would otherwise be suppressed.
  if (newlyTerminalRows(input.previousAggregate, input.nextAggregate).length > 0) {
    return true;
  }
  const lastDeliveryAtMs =
    input.lastDeliveryAt === null
      ? null
      : Option.match(DateTime.make(input.lastDeliveryAt), {
          onNone: () => Number.NaN,
          onSome: (dt) => dt.epochMilliseconds,
        });
  return (
    lastDeliveryAtMs === null ||
    Number.isNaN(lastDeliveryAtMs) ||
    input.nowMs - lastDeliveryAtMs >= MIN_LIVE_ACTIVITY_UPDATE_INTERVAL_MS
  );
}

// Completions replayed long after the fact (server restarts republish every
// recently-finished thread) must not ring the device again.
const TERMINAL_NOTIFICATION_FRESHNESS_MS = 2 * 60 * 1_000;

function notificationForAggregate(input: {
  readonly target: LiveActivities.TargetRow;
  readonly aggregate: RelayAgentActivityAggregateState | null;
  readonly nowMs: number;
}): ApnsNotificationPayload | null {
  if (!input.target.push_token || input.aggregate === null) {
    return null;
  }
  const preferences = parsePreferences(input.target.preferences_json);
  if (!preferences?.notificationsEnabled) {
    return null;
  }
  const activity = input.aggregate.activities[0];
  if (!activity) {
    return null;
  }
  if (activity.phase === "completed" || activity.phase === "failed") {
    const updatedAtMs = Option.match(DateTime.make(activity.updatedAt), {
      onNone: () => null,
      onSome: (dt) => dt.epochMilliseconds,
    });
    if (updatedAtMs === null || input.nowMs - updatedAtMs > TERMINAL_NOTIFICATION_FRESHNESS_MS) {
      return null;
    }
  }
  const enabled =
    (activity.phase === "waiting_for_approval" && preferences.notifyOnApproval) ||
    (activity.phase === "waiting_for_input" && preferences.notifyOnInput) ||
    (activity.phase === "completed" && preferences.notifyOnCompletion) ||
    (activity.phase === "failed" && preferences.notifyOnFailure);
  if (!enabled) {
    return null;
  }
  return {
    title: activity.threadTitle,
    body: `${activity.status}: ${activity.projectTitle}`,
    environmentId: activity.environmentId,
    threadId: activity.threadId,
    deepLink: activity.deepLink,
    phase: activity.phase,
    updatedAt: activity.updatedAt,
  };
}

// "suppressed" means a Live Activity owns this state but no update is due
// (unchanged or throttled); callers must not fall back to an alert push, or
// every republish of a waiting aggregate would ring the device.
function chooseLiveActivityDelivery(input: {
  readonly target: LiveActivities.TargetRow;
  readonly aggregate: RelayAgentActivityAggregateState | null;
  readonly nowMs: number;
}): ChosenLiveActivityDelivery | "suppressed" | null {
  const preferences = parsePreferences(input.target.preferences_json);
  if (preferences?.liveActivitiesEnabled === false) {
    return input.target.activity_push_token
      ? {
          kind: "live_activity_end",
          token: input.target.activity_push_token,
          aggregate: null,
          alert: null,
        }
      : null;
  }
  // Activities are started by the app in the foreground, never remotely.
  // Without a registered token there is nothing addressable; attention
  // transitions fall back to the push notification channel until the user
  // next arms the card from the app.
  if (!input.target.activity_push_token) {
    return null;
  }
  // An armed card always shows content: live agents, or recently finished
  // ones (the publisher keeps Done/Failed rows in the aggregate for a
  // while). A null aggregate means there is truly nothing left to show, so
  // the card ends — arming is cheap now that the app re-arms on any open
  // with content.
  if (input.aggregate === null) {
    // Except right after arming: the app arms the card the moment the user
    // starts work, and the token registration's replay can land before the
    // environment's first publish for the brand-new thread. Ending here
    // would retire the token and orphan the card at its seed content, so a
    // freshly armed card keeps its seed until real state arrives.
    const armedAtMs = Option.match(
      input.target.remote_started_at === null
        ? Option.none()
        : DateTime.make(input.target.remote_started_at),
      { onNone: () => null, onSome: (dt) => dt.epochMilliseconds },
    );
    if (armedAtMs !== null && input.nowMs - armedAtMs < FRESHLY_ARMED_GRACE_MS) {
      return null;
    }
    return {
      kind: "live_activity_end",
      token: input.target.activity_push_token,
      aggregate: null,
      alert: null,
    };
  }
  const nextAggregate = input.aggregate;
  const previousAggregate = parseAggregate(input.target.last_aggregate_json);
  return shouldUpdateLiveActivity({
    previousAggregate,
    nextAggregate,
    lastDeliveryAt: input.target.last_live_activity_delivery_at,
    nowMs: input.nowMs,
  })
    ? {
        kind: "live_activity_update",
        token: input.target.activity_push_token,
        aggregate: nextAggregate,
        alert:
          alertForAttentionTransition({
            previousAggregate,
            nextAggregate,
            preferences,
          }) ??
          alertForNewlyTerminal({
            previousAggregate,
            nextAggregate,
            preferences,
            nowMs: input.nowMs,
          }),
      }
    : "suppressed";
}

function chooseDelivery(input: {
  readonly target: LiveActivities.TargetRow;
  readonly aggregate: RelayAgentActivityAggregateState | null;
  readonly nowMs: number;
}): ChosenDelivery | null {
  const liveActivityDelivery = chooseLiveActivityDelivery(input);
  if (liveActivityDelivery === "suppressed") {
    return null;
  }
  if (liveActivityDelivery) {
    return liveActivityDelivery;
  }
  const notification = notificationForAggregate(input);
  return notification && input.target.push_token
    ? {
        kind: "push_notification",
        token: input.target.push_token,
        notification,
      }
    : null;
}

function deliveryEvent(kind: LiveActivityDeliveryKind): Apns.ApnsLiveActivityEvent {
  switch (kind) {
    case "live_activity_start":
      return "start";
    case "live_activity_update":
      return "update";
    case "live_activity_end":
      return "end";
  }
}

function isPermanentApnsTokenFailure(result: Apns.ApnsDeliveryResult): boolean {
  return (
    !result.ok &&
    (result.status === 410 ||
      (result.status === 400 &&
        result.reason !== undefined &&
        PERMANENT_APNS_TOKEN_REASONS.has(result.reason)))
  );
}

function duplicateJobResult(input: {
  readonly deviceId: string;
  readonly kind: RelayDeliveryKind;
}): RelayDeliveryResult {
  return {
    deviceId: input.deviceId,
    kind: input.kind,
    ok: true,
    apnsStatus: null,
    apnsReason: "Duplicate APNs delivery job skipped.",
    apnsId: null,
  };
}

function staleJobResult(input: {
  readonly deviceId: string;
  readonly kind: RelayDeliveryKind;
}): RelayDeliveryResult {
  return {
    deviceId: input.deviceId,
    kind: input.kind,
    ok: true,
    apnsStatus: null,
    apnsReason: "Stale APNs delivery job skipped.",
    apnsId: null,
  };
}

function deliveryAttemptOutcome(result: Apns.ApnsDeliveryResult) {
  return {
    ...(result.status === 0 ? {} : { apnsStatus: result.status }),
    ...(result.reason === undefined ? {} : { apnsReason: result.reason }),
    apnsId: result.apnsId,
    ...(result.status === 0 ? { transportError: result.reason ?? "APNs request failed." } : {}),
  };
}

const recoverApnsDeliveryTransportError = (
  input: {
    readonly deviceId: string;
    readonly kind: RelayDeliveryKind;
    readonly sourceJobId: string | null;
  },
  cause: Apns.ApnsError,
): Effect.Effect<Apns.ApnsDeliveryResult> => {
  const error = new ApnsDeliveryTransportError({
    deviceId: input.deviceId,
    kind: input.kind,
    sourceJobId: input.sourceJobId,
    apnsErrorTag: cause._tag,
    requestStage: cause._tag === "ApnsHttpRequestError" ? cause.stage : null,
    cause,
  });
  return Effect.logError(error.message).pipe(
    Effect.annotateLogs({
      error: Redacted.make(error, { label: error._tag }),
      "error.type": error._tag,
      "error.apns_error_tag": error.apnsErrorTag,
      ...(error.requestStage === null ? {} : { "error.request_stage": error.requestStage }),
      ...(error.stack === undefined ? {} : { "error.stack": error.stack }),
      "relay.mobile.device_id": error.deviceId,
      "relay.delivery.kind": error.kind,
      ...(error.sourceJobId === null ? {} : { "relay.delivery.job_id": error.sourceJobId }),
    }),
    Effect.as({
      ok: false,
      status: 0,
      reason: cause.message,
      apnsId: null,
    }),
  );
};

interface LiveActivityDeliveryTarget {
  readonly user_id: string;
  readonly device_id: string;
  readonly bundle_id?: string | null;
  readonly aps_environment?: "sandbox" | "production" | null;
}

// Devices register the bundle id and APS environment of the build they run
// (dev/preview/prod variants have distinct bundle ids; development-signed
// builds get sandbox tokens). Sending with mismatched routing yields
// DeviceTokenNotForTopic/BadDeviceToken, so per-device values override the
// relay-wide defaults when present.
function credentialsForTarget(
  credentials: RelayConfiguration.RelayConfiguration["Service"]["apns"],
  target: LiveActivityDeliveryTarget,
): RelayConfiguration.RelayConfiguration["Service"]["apns"] {
  return {
    ...credentials,
    ...(target.bundle_id ? { bundleId: target.bundle_id } : {}),
    ...(target.aps_environment ? { environment: target.aps_environment } : {}),
  };
}

function expectedCurrentToken(input: {
  readonly target: LiveActivities.TargetRow;
  readonly kind: RelayDeliveryKind;
}): string | null {
  switch (input.kind) {
    case "live_activity_start":
      return input.target.push_to_start_token;
    case "live_activity_update":
    case "live_activity_end":
      return input.target.activity_push_token;
    case "push_notification":
      return input.target.push_token;
  }
}

interface SendLiveActivityDeliveryInputBase {
  readonly target: LiveActivityDeliveryTarget;
  readonly token: string;
  readonly sourceJobId?: string | null;
}

export type SendLiveActivityDeliveryInput =
  | (SendLiveActivityDeliveryInputBase & {
      readonly kind: "live_activity_start" | "live_activity_update";
      readonly aggregate: RelayAgentActivityAggregateState;
      readonly alert?: ApnsLiveActivityAlert | null;
    })
  | (SendLiveActivityDeliveryInputBase & {
      readonly kind: "live_activity_end";
      readonly aggregate: RelayAgentActivityAggregateState | null;
      readonly alert?: ApnsLiveActivityAlert | null;
    });

function makeLiveActivityDeliveryRequest(
  apns: Apns.ApnsClient["Service"],
  input: SendLiveActivityDeliveryInput,
  now: DateTime.DateTime,
) {
  const epochSeconds = Math.floor(now.epochMilliseconds / 1_000);
  const base = {
    token: input.token,
    nowEpochSeconds: epochSeconds,
    nowIso: DateTime.formatIso(now),
  };
  switch (input.kind) {
    case "live_activity_start":
    case "live_activity_update":
      return {
        epochSeconds,
        iso: base.nowIso,
        request: apns.makeLiveActivityRequest({
          ...base,
          event: deliveryEvent(input.kind),
          state: input.aggregate,
          alert: input.alert ?? null,
        }),
      };
    case "live_activity_end":
      return {
        epochSeconds,
        iso: base.nowIso,
        request: apns.makeLiveActivityRequest({
          ...base,
          event: "end",
          state: input.aggregate,
          alert: input.alert ?? null,
        }),
      };
  }
}

export class ApnsDeliveries extends Context.Service<
  ApnsDeliveries,
  {
    readonly sendForTarget: (input: {
      readonly target: LiveActivities.TargetRow;
      readonly aggregate: RelayAgentActivityAggregateState | null;
      readonly nowMs: number;
    }) => Effect.Effect<RelayDeliveryResult | null, ApnsDeliveryError>;
    readonly sendPushNotificationForTarget: (input: {
      readonly target: LiveActivities.TargetRow;
      readonly aggregate: RelayAgentActivityAggregateState | null;
    }) => Effect.Effect<RelayDeliveryResult | null, ApnsDeliveryError>;
    readonly sendLiveActivity: (
      input: SendLiveActivityDeliveryInput,
    ) => Effect.Effect<RelayDeliveryResult, ApnsDeliveryError>;
    readonly processSignedJob: (
      body: unknown,
    ) => Effect.Effect<RelayDeliveryResult, ApnsDeliveryError>;
    readonly sendPushNotification: (input: {
      readonly target: LiveActivityDeliveryTarget;
      readonly token: string;
      readonly sourceJobId?: string | null;
      readonly notification: ApnsNotificationPayload;
    }) => Effect.Effect<RelayDeliveryResult, ApnsDeliveryError>;
  }
>()("t3code-relay/agentActivity/ApnsDeliveries") {}

export const make = Effect.gen(function* () {
  const attempts = yield* DeliveryAttempts.DeliveryAttempts;
  const liveActivities = yield* LiveActivities.LiveActivities;
  const deliveryQueue = yield* ApnsDeliveryQueue.ApnsDeliveryQueue;
  const config = yield* RelayConfiguration.RelayConfiguration;
  const apns = yield* Apns.ApnsClient;
  const activityRows = yield* AgentActivityRows.AgentActivityRows;

  // Start jobs are decided at publish time, but consecutive publishes land in
  // the same queue batch: a start chosen from a running aggregate can be
  // delivered moments after a newer terminal publish already ended the user's
  // work, birthing an orphan activity that shows stale content forever (no
  // token is ever registered for it, so nothing can update or end it).
  // Re-validate at delivery time that the user still has live work; fail open
  // on persistence errors so a database hiccup never drops a legitimate start.
  const userStillHasLiveWork = Effect.fnUntraced(function* (userId: string) {
    const now = yield* DateTime.now;
    return yield* activityRows.listForUser({ userId }).pipe(
      Effect.map((states) =>
        states.some(
          (state) =>
            !isTerminalPhase(state) && !isExpiredAgentActivityState(state, now.epochMilliseconds),
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("live-work recheck failed; allowing queued start", { cause }).pipe(
          Effect.as(true),
        ),
      ),
    );
  });

  const stateIdentityIsCurrent = Effect.fnUntraced(function* (input: {
    readonly userId: string;
    readonly environmentId: string;
    readonly threadId: string;
    readonly phase: RelayAgentActivityAggregateState["activities"][number]["phase"];
    readonly updatedAt: string;
  }) {
    return yield* activityRows
      .getForUserThread({
        userId: input.userId,
        environmentId: input.environmentId,
        threadId: input.threadId,
      })
      .pipe(
        Effect.map(
          (current) =>
            current !== null &&
            current.phase === input.phase &&
            current.updatedAt === input.updatedAt,
        ),
        // A transient persistence failure must not permanently discard a
        // legitimate alert. Fail open and let the signed job's retry/dedupe
        // protections handle transport failures as usual.
        Effect.catchCause((cause) =>
          Effect.logWarning("agent-activity state recheck failed; allowing queued delivery", {
            cause,
            environmentId: input.environmentId,
            threadId: input.threadId,
          }).pipe(Effect.as(true)),
        ),
      );
  });

  const aggregateRowsAreCurrent = Effect.fnUntraced(function* (input: {
    readonly userId: string;
    readonly aggregate: RelayAgentActivityAggregateState;
  }) {
    return yield* activityRows.listForUser({ userId: input.userId }).pipe(
      Effect.map((currentStates) => {
        const currentByThread = new Map(
          currentStates.map((current) => [
            `${current.environmentId}\u0000${current.threadId}`,
            current,
          ]),
        );
        return input.aggregate.activities.every((row) => {
          const current = currentByThread.get(`${row.environmentId}\u0000${row.threadId}`);
          return (
            current !== undefined &&
            current.phase === row.phase &&
            current.updatedAt === row.updatedAt
          );
        });
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("agent-activity aggregate recheck failed; allowing queued delivery", {
          cause,
          userId: input.userId,
        }).pipe(Effect.as(true)),
      ),
    );
  });

  const notificationStateIsCurrent = Effect.fnUntraced(function* (input: {
    readonly userId: string;
    readonly notification: ApnsNotificationPayload;
  }) {
    // Jobs from older relay versions do not carry a state identity. Preserve
    // backwards compatibility and only revalidate newly queued jobs.
    if (input.notification.phase === undefined || input.notification.updatedAt === undefined) {
      return true;
    }
    return yield* stateIdentityIsCurrent({
      userId: input.userId,
      environmentId: input.notification.environmentId,
      threadId: input.notification.threadId,
      phase: input.notification.phase,
      updatedAt: input.notification.updatedAt,
    });
  });

  const isCurrentSignedJobToken = Effect.fnUntraced(function* (input: {
    readonly target: LiveActivityDeliveryTarget;
    readonly kind: RelayDeliveryKind;
    readonly token: string;
  }) {
    return yield* liveActivities.listTargets({ userId: input.target.user_id }).pipe(
      Effect.map((targets) => {
        const currentTarget = targets.find((row) => row.device_id === input.target.device_id);
        return (
          currentTarget !== undefined &&
          expectedCurrentToken({ target: currentTarget, kind: input.kind }) === input.token
        );
      }),
    );
  });

  const sendLiveActivity: ApnsDeliveries["Service"]["sendLiveActivity"] = Effect.fn(
    "relay.apns_deliveries.send_live_activity",
  )(function* (input) {
    yield* Effect.annotateCurrentSpan({
      "relay.mobile.device_id": input.target.device_id,
      "relay.delivery.kind": input.kind,
      ...(input.sourceJobId ? { "relay.delivery.job_id": input.sourceJobId } : {}),
    });
    const now = yield* DateTime.now;
    const aggregate =
      input.aggregate === null ? null : sanitizeAgentActivityAggregateState(input.aggregate);
    const { epochSeconds, iso, request } = makeLiveActivityDeliveryRequest(
      apns,
      { ...input, aggregate } as SendLiveActivityDeliveryInput,
      now,
    );
    const recoverTransportError = (cause: Apns.ApnsError) =>
      recoverApnsDeliveryTransportError(
        {
          deviceId: input.target.device_id,
          kind: input.kind,
          sourceJobId: input.sourceJobId ?? null,
        },
        cause,
      );
    if (input.sourceJobId) {
      const claim = yield* attempts.claimSourceJob({
        userId: input.target.user_id,
        environmentId: null,
        threadId: null,
        deviceId: input.target.device_id,
        kind: input.kind,
        sourceJobId: input.sourceJobId,
        token: input.token,
      });
      if (claim === "completed") {
        return duplicateJobResult({ deviceId: input.target.device_id, kind: input.kind });
      }
      if (claim === "in_flight") {
        return yield* new ApnsDeliveryJobClaimInFlight({ sourceJobId: input.sourceJobId });
      }
      const tokenIsCurrent = yield* isCurrentSignedJobToken({
        target: input.target,
        kind: input.kind,
        token: input.token,
      });
      if (!tokenIsCurrent) {
        yield* attempts.completeSourceJob({
          sourceJobId: input.sourceJobId,
          apnsReason: "Stale APNs delivery job skipped.",
        });
        return staleJobResult({ deviceId: input.target.device_id, kind: input.kind });
      }
      if (
        input.kind !== "live_activity_start" &&
        aggregate !== null &&
        !(yield* aggregateRowsAreCurrent({
          userId: input.target.user_id,
          aggregate,
        }))
      ) {
        yield* attempts.completeSourceJob({
          sourceJobId: input.sourceJobId,
          apnsReason: "Stale agent activity state skipped.",
        });
        return staleJobResult({ deviceId: input.target.device_id, kind: input.kind });
      }
    }
    if (
      input.kind === "live_activity_start" &&
      !(yield* userStillHasLiveWork(input.target.user_id))
    ) {
      yield* liveActivities.clearStartQueued({
        userId: input.target.user_id,
        deviceId: input.target.device_id,
      });
      if (input.sourceJobId) {
        yield* attempts.completeSourceJob({
          sourceJobId: input.sourceJobId,
          apnsReason: "Stale APNs start job skipped.",
        });
      }
      return staleJobResult({ deviceId: input.target.device_id, kind: input.kind });
    }
    const result = yield* apns
      .sendLiveActivityRequest({
        credentials: credentialsForTarget(config.apns, input.target),
        request,
        issuedAtUnixSeconds: epochSeconds,
      })
      .pipe(
        Effect.catchTags({
          ApnsJwtEncodingError: recoverTransportError,
          ApnsJwtSigningError: recoverTransportError,
          ApnsHttpRequestError: recoverTransportError,
        }),
      );
    if (result.ok) {
      yield* liveActivities.markDelivery({
        userId: input.target.user_id,
        deviceId: input.target.device_id,
        kind: input.kind,
        aggregate,
        deliveredAt: iso,
      });
    } else if (isPermanentApnsTokenFailure(result)) {
      yield* liveActivities.invalidateDeliveryToken({
        userId: input.target.user_id,
        deviceId: input.target.device_id,
        kind: input.kind,
        invalidatedAt: iso,
      });
    } else if (input.kind === "live_activity_start") {
      yield* liveActivities.clearStartQueued({
        userId: input.target.user_id,
        deviceId: input.target.device_id,
      });
    }
    if (input.sourceJobId) {
      yield* attempts.completeSourceJob({
        sourceJobId: input.sourceJobId,
        ...deliveryAttemptOutcome(result),
      });
    } else {
      yield* attempts.record({
        userId: input.target.user_id,
        environmentId: null,
        threadId: null,
        deviceId: input.target.device_id,
        kind: input.kind,
        token: input.token,
        ...deliveryAttemptOutcome(result),
      });
    }
    return {
      deviceId: input.target.device_id,
      kind: input.kind,
      ok: result.ok,
      apnsStatus: result.status === 0 ? null : result.status,
      apnsReason: result.reason ?? null,
      apnsId: result.apnsId,
    };
  });

  const sendPushNotification: ApnsDeliveries["Service"]["sendPushNotification"] = Effect.fn(
    "relay.apns_deliveries.send_push_notification",
  )(function* (input) {
    yield* Effect.annotateCurrentSpan({
      "relay.mobile.device_id": input.target.device_id,
      "relay.delivery.kind": "push_notification",
      ...(input.sourceJobId ? { "relay.delivery.job_id": input.sourceJobId } : {}),
    });
    const now = yield* DateTime.now;
    const epochSeconds = Math.floor(now.epochMilliseconds / 1_000);
    const notification = sanitizeApnsNotificationPayload(input.notification);
    yield* Effect.annotateCurrentSpan({
      "relay.environment_id": notification.environmentId,
      "relay.thread_id": notification.threadId,
    });
    const request = apns.makePushNotificationRequest({
      token: input.token,
      notification,
    });
    const recoverTransportError = (cause: Apns.ApnsError) =>
      recoverApnsDeliveryTransportError(
        {
          deviceId: input.target.device_id,
          kind: "push_notification",
          sourceJobId: input.sourceJobId ?? null,
        },
        cause,
      );
    if (input.sourceJobId) {
      const claim = yield* attempts.claimSourceJob({
        userId: input.target.user_id,
        environmentId: notification.environmentId,
        threadId: notification.threadId,
        deviceId: input.target.device_id,
        kind: "push_notification",
        sourceJobId: input.sourceJobId,
        token: input.token,
      });
      if (claim === "completed") {
        return duplicateJobResult({
          deviceId: input.target.device_id,
          kind: "push_notification",
        });
      }
      if (claim === "in_flight") {
        return yield* new ApnsDeliveryJobClaimInFlight({ sourceJobId: input.sourceJobId });
      }
      const tokenIsCurrent = yield* isCurrentSignedJobToken({
        target: input.target,
        kind: "push_notification",
        token: input.token,
      });
      if (!tokenIsCurrent) {
        yield* attempts.completeSourceJob({
          sourceJobId: input.sourceJobId,
          apnsReason: "Stale APNs delivery job skipped.",
        });
        return staleJobResult({
          deviceId: input.target.device_id,
          kind: "push_notification",
        });
      }
      if (
        !(yield* notificationStateIsCurrent({
          userId: input.target.user_id,
          notification,
        }))
      ) {
        yield* attempts.completeSourceJob({
          sourceJobId: input.sourceJobId,
          apnsReason: "Stale agent activity state skipped.",
        });
        return staleJobResult({
          deviceId: input.target.device_id,
          kind: "push_notification",
        });
      }
    }
    const result = yield* apns
      .sendPushNotificationRequest({
        credentials: credentialsForTarget(config.apns, input.target),
        request,
        issuedAtUnixSeconds: epochSeconds,
      })
      .pipe(
        Effect.catchTags({
          ApnsJwtEncodingError: recoverTransportError,
          ApnsJwtSigningError: recoverTransportError,
          ApnsHttpRequestError: recoverTransportError,
        }),
      );
    if (isPermanentApnsTokenFailure(result)) {
      yield* liveActivities.invalidateDeliveryToken({
        userId: input.target.user_id,
        deviceId: input.target.device_id,
        kind: "push_notification",
        invalidatedAt: DateTime.formatIso(now),
      });
    }
    if (input.sourceJobId) {
      yield* attempts.completeSourceJob({
        sourceJobId: input.sourceJobId,
        ...deliveryAttemptOutcome(result),
      });
    } else {
      yield* attempts.record({
        userId: input.target.user_id,
        environmentId: notification.environmentId,
        threadId: notification.threadId,
        deviceId: input.target.device_id,
        kind: "push_notification",
        token: input.token,
        ...deliveryAttemptOutcome(result),
      });
    }
    return {
      deviceId: input.target.device_id,
      kind: "push_notification" as const,
      ok: result.ok,
      apnsStatus: result.status === 0 ? null : result.status,
      apnsReason: result.reason ?? null,
      apnsId: result.apnsId,
    };
  });

  const processSignedJob: ApnsDeliveries["Service"]["processSignedJob"] = Effect.fn(
    "relay.apns_deliveries.process_signed_job",
  )(function* (body) {
    const signedJob = yield* decodeSignedApnsDeliveryJob(body).pipe(
      Effect.mapError(
        (cause) =>
          new ApnsDeliveryJobQueuePayloadInvalid({
            receivedType: Array.isArray(body) ? "array" : body === null ? "null" : typeof body,
            cause,
          }),
      ),
    );
    const now = yield* DateTime.now;
    const payload = verifySignedApnsDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      job: signedJob,
      nowMs: now.epochMilliseconds,
    });
    if (isApnsDeliveryJobVerificationError(payload)) {
      return yield* payload;
    }
    yield* Effect.annotateCurrentSpan({
      "relay.mobile.device_id": payload.target.deviceId,
      "relay.delivery.kind": payload.kind,
      "relay.delivery.job_id": payload.jobId,
    });
    return yield* Effect.suspend(() => {
      switch (payload.kind) {
        case "live_activity_start":
        case "live_activity_update":
          if (payload.aggregate === null) {
            return Effect.fail(
              new ApnsDeliveryJobLiveActivityAggregateMissing({
                jobId: payload.jobId,
                kind: payload.kind,
                userId: payload.target.userId,
                deviceId: payload.target.deviceId,
              }),
            );
          }
          return sendLiveActivity({
            target: {
              user_id: payload.target.userId,
              device_id: payload.target.deviceId,
              bundle_id: payload.target.bundleId ?? null,
              aps_environment: payload.target.apsEnvironment ?? null,
            },
            token: payload.target.token,
            sourceJobId: payload.jobId,
            kind: payload.kind,
            aggregate: payload.aggregate,
            alert: payload.alert ?? null,
          });
        case "live_activity_end":
          return sendLiveActivity({
            target: {
              user_id: payload.target.userId,
              device_id: payload.target.deviceId,
              bundle_id: payload.target.bundleId ?? null,
              aps_environment: payload.target.apsEnvironment ?? null,
            },
            token: payload.target.token,
            sourceJobId: payload.jobId,
            kind: payload.kind,
            aggregate: payload.aggregate,
            alert: payload.alert ?? null,
          });
        case "push_notification":
          if (payload.notification === null) {
            return Effect.fail(
              new ApnsDeliveryJobPushNotificationMissing({
                jobId: payload.jobId,
                userId: payload.target.userId,
                deviceId: payload.target.deviceId,
              }),
            );
          }
          return sendPushNotification({
            target: {
              user_id: payload.target.userId,
              device_id: payload.target.deviceId,
              bundle_id: payload.target.bundleId ?? null,
              aps_environment: payload.target.apsEnvironment ?? null,
            },
            token: payload.target.token,
            sourceJobId: payload.jobId,
            notification: payload.notification,
          });
      }
    }).pipe(withSpanAttributes({ "user.id": payload.target.userId }));
  });

  return ApnsDeliveries.of({
    sendLiveActivity,
    sendPushNotification,
    processSignedJob,
    sendPushNotificationForTarget: Effect.fnUntraced(function* (input) {
      const now = yield* DateTime.now;
      const notification = notificationForAggregate({
        target: input.target,
        aggregate: input.aggregate,
        nowMs: now.epochMilliseconds,
      });
      const token = input.target.push_token;
      return yield* notification && token
        ? deliveryQueue.enqueuePushNotification({
            userId: input.target.user_id,
            deviceId: input.target.device_id,
            token,
            bundleId: input.target.bundle_id,
            apsEnvironment: input.target.aps_environment,
            notification,
          })
        : Effect.succeed(null);
    }),
    sendForTarget: Effect.fnUntraced(function* (input) {
      const delivery = chooseDelivery({
        target: input.target,
        aggregate: input.aggregate,
        nowMs: input.nowMs,
      });
      if (!delivery) {
        return null;
      }
      if (delivery.kind === "push_notification") {
        const result = yield* deliveryQueue.enqueuePushNotification({
          userId: input.target.user_id,
          deviceId: input.target.device_id,
          token: delivery.token,
          bundleId: input.target.bundle_id,
          apsEnvironment: input.target.aps_environment,
          notification: delivery.notification,
        });
        return result;
      }
      const notification = notificationForAggregate({
        target: input.target,
        aggregate: input.aggregate,
        nowMs: input.nowMs,
      });
      // The end event doubles as the "task finished" moment. When a companion
      // push notification is about to ring the device (below), the activity end
      // stays silent; otherwise the end itself carries the alert so LA-only
      // users still get the buzz.
      const alert =
        delivery.kind === "live_activity_end"
          ? notification && input.target.push_token
            ? null
            : alertForTerminalAggregate({
                aggregate: delivery.aggregate,
                preferences: parsePreferences(input.target.preferences_json),
              })
          : delivery.alert;
      const result = yield* deliveryQueue.enqueueLiveActivity({
        userId: input.target.user_id,
        deviceId: input.target.device_id,
        kind: delivery.kind,
        token: delivery.token,
        bundleId: input.target.bundle_id,
        apsEnvironment: input.target.aps_environment,
        aggregate: delivery.aggregate,
        alert,
      });
      if (delivery.kind === "live_activity_end" && notification && input.target.push_token) {
        yield* deliveryQueue.enqueuePushNotification({
          userId: input.target.user_id,
          deviceId: input.target.device_id,
          token: input.target.push_token,
          bundleId: input.target.bundle_id,
          apsEnvironment: input.target.aps_environment,
          notification,
        });
      }
      if (delivery.kind === "live_activity_start") {
        const now = yield* DateTime.now;
        yield* liveActivities.markStartQueued({
          userId: input.target.user_id,
          deviceId: input.target.device_id,
          queuedAt: DateTime.formatIso(now),
        });
      }
      return result;
    }),
  });
});

export const layer = Layer.effect(ApnsDeliveries, make);
