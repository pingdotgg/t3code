import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { UsageLimitSourceAccountLogin } from "./forkUsageAccountLogin.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { UsageLimitSourceId } from "./usageLimitSourceId.ts";

/** Stable per-provider ids let sparse updates merge with full probes. */
export const ServerProviderUsageWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: Schema.Literals(["session", "weekly", "monthly", "other"]),
  label: TrimmedNonEmptyString,
  usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resetsAt: Schema.optional(IsoDateTime),
  windowDurationMins: Schema.optional(NonNegativeInt),
});
export type ServerProviderUsageWindow = typeof ServerProviderUsageWindow.Type;

export const ServerProviderResetCredits = Schema.Struct({
  availableCount: NonNegativeInt,
  nextExpiresAt: Schema.optional(IsoDateTime),
  /** Pins hub redemption to the displayed credit, including retries from another client. */
  nextCreditId: Schema.optional(TrimmedNonEmptyString),
  /**
   * How many of `availableCount` would act if redeemed now. Absent when the
   * provider does not say; Codex reports 0 while no limit is reached.
   */
  usableNowCount: Schema.optional(NonNegativeInt),
  /** Fork: Claude resets that clear only the Fable bucket, counted apart. */
  fable: Schema.optional(
    Schema.Struct({
      availableCount: NonNegativeInt,
      nextExpiresAt: Schema.optional(IsoDateTime),
      nextCreditId: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
});
export type ServerProviderResetCredits = typeof ServerProviderResetCredits.Type;

/** Clear bars for unavailable accounts; retain last good bars after a failed probe. */
export const ServerProviderUsageLimits = Schema.Struct({
  checkedAt: IsoDateTime,
  windows: ForwardCompatibleArray(ServerProviderUsageWindow),
  credentialFingerprint: Schema.optional(TrimmedNonEmptyString),
  resetCredits: Schema.optional(ServerProviderResetCredits),
  externalUsage: Schema.optional(
    Schema.Struct({
      label: TrimmedNonEmptyString,
      url: TrimmedNonEmptyString,
    }),
  ),
  unavailable: Schema.optional(
    Schema.Struct({
      reason: Schema.Literals(["unsupported", "probeFailed"]),
      message: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
});
export type ServerProviderUsageLimits = typeof ServerProviderUsageLimits.Type;

/** Partial updates merge windows by id; omitted windows remain unchanged. */
export const ProviderUsageLimitsUpdate = Schema.Struct({
  windows: Schema.Array(ServerProviderUsageWindow),
});
export type ProviderUsageLimitsUpdate = typeof ProviderUsageLimitsUpdate.Type;

/**
 * What a modelproxy gateway says one pooled account is doing now, in the gateway's own vocabulary:
 * `live` serves traffic, `ready` may be selected, `cooling` is parked after a rejection, `paused`
 * is disabled by the operator, and the last two are terminal conditions the operator must act on.
 */
export const UsageLimitSourceProxyAccountState = Schema.Literals([
  "live",
  "ready",
  "cooling",
  "paused",
  "reauthentication",
  "suspended",
]);
export type UsageLimitSourceProxyAccountState = typeof UsageLimitSourceProxyAccountState.Type;

export const UsageLimitSourceProxyAccount = Schema.Struct({
  state: UsageLimitSourceProxyAccountState,
  coolingUntil: Schema.optional(IsoDateTime),
  /** The upstream keeps serving from purchased credits once the windows are spent. */
  credits: Schema.optional(Schema.Boolean),
  inflight: NonNegativeInt,
});
export type UsageLimitSourceProxyAccount = typeof UsageLimitSourceProxyAccount.Type;

export const UsageLimitSourceAccount = Schema.Struct({
  id: TrimmedNonEmptyString,
  driver: ProviderDriverKind,
  email: Schema.optional(TrimmedNonEmptyString),
  plan: Schema.optional(TrimmedNonEmptyString),
  workspaceId: Schema.optional(TrimmedNonEmptyString),
  usageLimits: ServerProviderUsageLimits,
  /** Present on `modelproxy` sources only. */
  proxy: Schema.optional(UsageLimitSourceProxyAccount),
});
export type UsageLimitSourceAccount = typeof UsageLimitSourceAccount.Type;

/** Mirrors modelproxy's forecast runway kinds. */
export const UsageLimitSourceRunway = Schema.Struct({
  kind: Schema.Literals(["at", "idle", "beyondHorizon", "resetsFirst", "unknown", "disabled"]),
  at: Schema.optional(IsoDateTime),
});
export type UsageLimitSourceRunway = typeof UsageLimitSourceRunway.Type;

/**
 * Where the server stands with the gateway's sign-in. `pending` carries the
 * device code the user must enter; it is published so any client of this
 * environment can show it, not only the one that started the flow.
 */
export const UsageLimitSourceAuthState = Schema.Union([
  Schema.Struct({ state: Schema.Literal("signedOut") }),
  Schema.Struct({ state: Schema.Literal("signedIn") }),
  Schema.Struct({
    state: Schema.Literal("pending"),
    userCode: TrimmedNonEmptyString,
    verificationUrl: TrimmedNonEmptyString,
    /** The URL with the code already filled in, when the issuer offers one. */
    verificationUrlComplete: Schema.optional(TrimmedNonEmptyString),
    expiresAt: IsoDateTime,
  }),
]);
export type UsageLimitSourceAuthState = typeof UsageLimitSourceAuthState.Type;

/** A metered account the gateway spills to once the subscriptions are spent. */
export const UsageLimitSourceProxyFallback = Schema.Struct({
  name: TrimmedNonEmptyString,
  provider: TrimmedNonEmptyString,
  spendUsd: Schema.Number,
  /** Absent when the gateway imposes no cap. */
  capUsd: Schema.optional(Schema.Number),
  /** `day` or `month`. */
  window: Schema.optional(TrimmedNonEmptyString),
});
export type UsageLimitSourceProxyFallback = typeof UsageLimitSourceProxyFallback.Type;

/**
 * A model name the gateway serves from somewhere other than its own name,
 * e.g. `kimi-k3` answered by `moonshotai/kimi-k3` on OpenRouter. Only model
 * routes are published: a fallback route's `from` is a model the picker
 * already offers.
 */
export const UsageLimitSourceProxyRoute = Schema.Struct({
  /** The name a client requests. */
  from: TrimmedNonEmptyString,
  /** The upstream model that serves it. */
  to: TrimmedNonEmptyString,
  /** The upstream family, e.g. `openrouter`, `openai`, `anthropic`. */
  provider: TrimmedNonEmptyString,
  /** The gateway's route kind; absent means a model route. */
  kind: Schema.optional(TrimmedNonEmptyString),
});
export type UsageLimitSourceProxyRoute = typeof UsageLimitSourceProxyRoute.Type;

/**
 * Gateway-wide state from a `modelproxy` source: what the header widget
 * needs beyond the per-account windows.
 */
export const UsageLimitSourceProxyStatus = Schema.Struct({
  auth: UsageLimitSourceAuthState,
  /** `accounts[].id` of the account serving traffic, when one is. */
  current: Schema.optional(TrimmedNonEmptyString),
  /** Utilisation at which the gateway rotates off the shared windows, 0-100. */
  rotationThresholdPercent: Schema.optional(Schema.Number),
  /** The same for per-model weekly buckets. */
  modelThresholdPercent: Schema.optional(Schema.Number),
  runway: Schema.optional(UsageLimitSourceRunway),
  fallback: Schema.optional(ForwardCompatibleArray(UsageLimitSourceProxyFallback)),
  inflightTotal: Schema.optional(NonNegativeInt),
  queueDepth: Schema.optional(NonNegativeInt),
  /** Absent from gateways that predate route publishing. */
  routes: Schema.optional(ForwardCompatibleArray(UsageLimitSourceProxyRoute)),
  /** Fork: account logins open on the gateway (forkUsageAccountLogin.ts). */
  accountLogins: Schema.optional(ForwardCompatibleArray(UsageLimitSourceAccountLogin)),
  /**
   * Fork: the server holds the gateway's status stream open, so this
   * snapshot moves when the gateway does. Absent while it only polls.
   */
  following: Schema.optional(Schema.Literal(true)),
});
export type UsageLimitSourceProxyStatus = typeof UsageLimitSourceProxyStatus.Type;

export const UsageLimitSourceSnapshot = Schema.Struct({
  id: UsageLimitSourceId,
  kind: Schema.Literals(["cliproxy", "modelproxy"]),
  label: TrimmedNonEmptyString,
  checkedAt: IsoDateTime,
  accounts: ForwardCompatibleArray(UsageLimitSourceAccount),
  error: Schema.optional(TrimmedNonEmptyString),
  /** Present on `modelproxy` sources, even while signed out. */
  proxy: Schema.optional(UsageLimitSourceProxyStatus),
});
export type UsageLimitSourceSnapshot = typeof UsageLimitSourceSnapshot.Type;

/** Drive a `modelproxy` source's sign-in. `start` is idempotent while a flow is pending. */
export const UsageLimitSourceAuthInput = Schema.Struct({
  sourceId: UsageLimitSourceId,
  action: Schema.Literals(["start", "cancel", "signOut"]),
});
export type UsageLimitSourceAuthInput = typeof UsageLimitSourceAuthInput.Type;

export const UsageLimitSourceSnapshots = ForwardCompatibleArray(UsageLimitSourceSnapshot);
export type UsageLimitSourceSnapshots = typeof UsageLimitSourceSnapshots.Type;

export const UsageLimitSourceConsumeResetCreditInput = Schema.Struct({
  sourceId: UsageLimitSourceId,
  accountId: TrimmedNonEmptyString,
  creditId: TrimmedNonEmptyString,
});
export type UsageLimitSourceConsumeResetCreditInput =
  typeof UsageLimitSourceConsumeResetCreditInput.Type;

export const ProviderConsumeResetCreditInput = Schema.Union([
  Schema.Struct({ instanceId: ProviderInstanceId }),
  UsageLimitSourceConsumeResetCreditInput,
]);
export type ProviderConsumeResetCreditInput = typeof ProviderConsumeResetCreditInput.Type;

export class UsageLimitSourceError extends Schema.TaggedError<UsageLimitSourceError>()(
  "UsageLimitSourceError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export const ProviderConsumeResetCreditOutcome = Schema.Literals([
  "reset",
  "nothingToReset",
  "noCredit",
  "alreadyRedeemed",
]);
export type ProviderConsumeResetCreditOutcome = typeof ProviderConsumeResetCreditOutcome.Type;

export const ProviderConsumeResetCreditResult = Schema.Struct({
  outcome: ProviderConsumeResetCreditOutcome,
  warning: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderConsumeResetCreditResult = typeof ProviderConsumeResetCreditResult.Type;

export const UsageLimitsReport = Schema.Struct({
  createdAt: IsoDateTime,
  accounts: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      driver: ProviderDriverKind,
      label: TrimmedNonEmptyString,
      plan: Schema.optional(TrimmedNonEmptyString),
      email: Schema.optional(TrimmedNonEmptyString),
      sourceLabel: Schema.optional(TrimmedNonEmptyString),
      instanceId: Schema.optional(ProviderInstanceId),
      resetCreditInput: Schema.optional(ProviderConsumeResetCreditInput),
      displayName: Schema.optional(Schema.String),
      accentColor: Schema.optional(Schema.String),
      limits: ServerProviderUsageLimits,
    }),
  ),
  notices: Schema.Array(Schema.String),
});
export type UsageLimitsReport = typeof UsageLimitsReport.Type;
