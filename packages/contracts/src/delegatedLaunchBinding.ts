import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * The `codex-t3` wrapper's versioned pool protocol (dotfiles
 * `scripts/codex_t3_contract.py`, proxy `docs/delegated-launch.md` v2). Every
 * field is nonsecret: a binding path is not bearer authority without the
 * launcher's own client credential, which never reaches T3.
 */
export const CODEX_POOL_PROTOCOL = "codex-t3-pool-v2";

export const CodexPoolSessionId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]{1,128}$/));
export const CodexPoolRequestId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]{1,256}$/));
export const CodexPoolQuotaDomain = Schema.String.check(
  Schema.isPattern(/^codex:credential:[A-Za-z0-9_.:@-]{1,495}$/),
);
export const CodexPoolBindingId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{48}$/));
// Go RFC3339Nano, UTC or a numeric offset; naive times are refused.
export const CodexPoolTimestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?(Z|[+-]\d\d:\d\d)$/),
);

export const CodexPoolPrepareRequest = Schema.Struct({
  clientRequestId: CodexPoolRequestId,
  sessionId: CodexPoolSessionId,
  provider: Schema.Literal("codex"),
  model: CodexPoolSessionId,
  blockedQuotaDomains: Schema.Array(CodexPoolQuotaDomain).check(Schema.isMaxLength(64)),
});
export type CodexPoolPrepareRequest = typeof CodexPoolPrepareRequest.Type;

export const CodexPoolWindow = Schema.Struct({
  id: Schema.Literals(["primary", "secondary"]),
  usedPercent: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resetsAt: CodexPoolTimestamp,
});

/** The exact ready result; the wrapper replays prepare and requires equality. */
export const CodexPoolReadyResult = Schema.Struct({
  protocolVersion: Schema.Literal(2),
  status: Schema.Literal("ready"),
  checkedAt: CodexPoolTimestamp,
  expiresAt: CodexPoolTimestamp,
  ordinaryUsageAllowed: Schema.Literal(true),
  quotaDomains: Schema.Array(CodexPoolQuotaDomain).check(Schema.isBetweenLength(1, 256)),
  quotaScope: Schema.optionalKey(Schema.Literal("account")),
  bindingId: CodexPoolBindingId,
  basePath: Schema.String,
  provider: Schema.Literal("codex"),
  model: CodexPoolSessionId,
  sessionId: CodexPoolSessionId,
  windows: Schema.Array(CodexPoolWindow).check(Schema.isBetweenLength(1, 16)),
});
export type CodexPoolReadyResult = typeof CodexPoolReadyResult.Type;

export const DelegatedLaunchBinding = Schema.Struct({
  protocol: Schema.Literal(CODEX_POOL_PROTOCOL),
  instanceId: ProviderInstanceId,
  prepareRequest: CodexPoolPrepareRequest,
  result: CodexPoolReadyResult,
});
export type DelegatedLaunchBinding = typeof DelegatedLaunchBinding.Type;

export const CodexPoolRefusalCode = Schema.Literals([
  "invalid_request",
  "invalid_prepare",
  "idempotency_conflict",
  "prepare_cancelled",
  "binding_released",
  "pool_busy",
  "pool_unavailable",
  "binding_unavailable",
  "no_verified_account",
  "capacity_unverified",
  "usage_limit",
  "model_quota",
  "quota_unverified",
  "throttled",
  "model_capacity",
  "binding_busy",
  "binding_changed",
  "binding_invalid",
  "model_mismatch",
  "transport_unsupported",
  "authentication_required",
  "upstream_error",
]);

export const CodexPoolQuotaScope = Schema.Literals(["account", "model", "unknown", "transient"]);

/** Authenticated binding state: the only trusted source of refusal scope. */
export const CodexPoolBindingState = Schema.Struct({
  protocolVersion: Schema.Literal(2),
  state: Schema.Literals(["pending", "established", "released", "invalid"]),
  active: Schema.Boolean,
  executorAttempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  refusalVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  refusal: Schema.optionalKey(
    Schema.Struct({
      code: CodexPoolRefusalCode,
      quotaScope: CodexPoolQuotaScope,
      quotaDomains: Schema.Array(CodexPoolQuotaDomain),
      bindingId: Schema.optionalKey(CodexPoolBindingId),
      attemptedAccountDomain: Schema.optionalKey(CodexPoolQuotaDomain),
    }),
  ),
});
export type CodexPoolBindingState = typeof CodexPoolBindingState.Type;
