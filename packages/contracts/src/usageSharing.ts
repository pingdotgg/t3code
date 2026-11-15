import * as Schema from "effect/Schema";

/**
 * Owners share what they may share (their own API keys, local models) through a relay on their
 * own server; their credentials and data never leave it. Consumer subscriptions are not relayed:
 * Anthropic and OpenAI forbid making an account available to others.
 */
export const UsageShareSourceKind = Schema.Literals([
  "anthropic-api",
  "openai-api",
  "openrouter-api",
  "ollama",
]);
export type UsageShareSourceKind = typeof UsageShareSourceKind.Type;

export const UsageSharePeriod = Schema.Literals(["day", "week", "month", "total"]);
export type UsageSharePeriod = typeof UsageSharePeriod.Type;

export const UsageShareLimits = Schema.Struct({
  maxRequests: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  maxTokens: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  period: UsageSharePeriod,
  maxConcurrent: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
});
export type UsageShareLimits = typeof UsageShareLimits.Type;

export const UsageShareUsage = Schema.Struct({
  periodStart: Schema.String,
  requests: Schema.Int,
  inputTokens: Schema.Int,
  outputTokens: Schema.Int,
});
export type UsageShareUsage = typeof UsageShareUsage.Type;

export const UsageShareGrantStatus = Schema.Literals([
  "active",
  "paused",
  "revoked",
  "expired",
  "limit-reached",
]);
export type UsageShareGrantStatus = typeof UsageShareGrantStatus.Type;

/** A sharing code as the owner sees it. The secret itself is never stored or shown again. */
export const UsageShareGrant = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  /** The owner's note about who has it. Never sent to the recipient. */
  recipientNote: Schema.String,
  sourceKind: UsageShareSourceKind,
  models: Schema.Array(Schema.String),
  limits: UsageShareLimits,
  usage: UsageShareUsage,
  status: UsageShareGrantStatus,
  createdAt: Schema.String,
  expiresAt: Schema.NullOr(Schema.String),
  lastUsedAt: Schema.NullOr(Schema.String),
  inFlight: Schema.Int,
});
export type UsageShareGrant = typeof UsageShareGrant.Type;

export const UsageShareSource = Schema.Struct({
  kind: UsageShareSourceKind,
  /** True once the owner saved a key (or, for Ollama, a reachable address). Keys are never sent back. */
  configured: Schema.Boolean,
  baseUrl: Schema.NullOr(Schema.String),
});
export type UsageShareSource = typeof UsageShareSource.Type;

/** A shared connection redeemed on this machine. */
export const UsageShareConnection = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  sourceKind: UsageShareSourceKind,
  endpointHost: Schema.String,
  models: Schema.Array(Schema.String),
  providerInstanceId: Schema.String,
  status: Schema.Literals([
    "ready",
    "paused",
    "revoked",
    "unreachable",
    "limit-reached",
    "expired",
  ]),
  statusMessage: Schema.NullOr(Schema.String),
  limits: Schema.NullOr(UsageShareLimits),
  usage: Schema.NullOr(UsageShareUsage),
  redeemedAt: Schema.String,
  checkedAt: Schema.NullOr(Schema.String),
});
export type UsageShareConnection = typeof UsageShareConnection.Type;

export const UsageSharingOverview = Schema.Struct({
  /** The address recipients reach this server at; null until the owner sets one. */
  endpoint: Schema.NullOr(Schema.String),
  sources: Schema.Array(UsageShareSource),
  grants: Schema.Array(UsageShareGrant),
  connections: Schema.Array(UsageShareConnection),
});
export type UsageSharingOverview = typeof UsageSharingOverview.Type;

export const UsageShareSetSourceInput = Schema.Struct({
  kind: UsageShareSourceKind,
  /** The owner's own API key. Stored in the server's secret store; null removes it. */
  apiKey: Schema.optionalKey(Schema.NullOr(Schema.String)),
  baseUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

export const UsageShareSetEndpointInput = Schema.Struct({ endpoint: Schema.NullOr(Schema.String) });

export const UsageShareCreateGrantInput = Schema.Struct({
  label: Schema.String,
  recipientNote: Schema.String,
  sourceKind: UsageShareSourceKind,
  models: Schema.Array(Schema.String),
  limits: UsageShareLimits,
  expiresAt: Schema.NullOr(Schema.String),
});

export const UsageShareCodeResult = Schema.Struct({
  grant: UsageShareGrant,
  /** Shown once. Only a hash of its secret is kept. */
  code: Schema.String,
});
export type UsageShareCodeResult = typeof UsageShareCodeResult.Type;

export const UsageShareUpdateGrantInput = Schema.Struct({
  id: Schema.String,
  label: Schema.optionalKey(Schema.String),
  recipientNote: Schema.optionalKey(Schema.String),
  models: Schema.optionalKey(Schema.Array(Schema.String)),
  limits: Schema.optionalKey(UsageShareLimits),
  expiresAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** Pause or resume. Revoking is separate and final. */
  paused: Schema.optionalKey(Schema.Boolean),
  resetUsage: Schema.optionalKey(Schema.Boolean),
});

export const UsageShareGrantIdInput = Schema.Struct({ id: Schema.String });
export const UsageShareRedeemInput = Schema.Struct({ code: Schema.String });
export const UsageShareConnectionIdInput = Schema.Struct({ id: Schema.String });

export class UsageSharingError extends Schema.TaggedError<UsageSharingError>()(
  "UsageSharingError",
  { message: Schema.String },
) {}
