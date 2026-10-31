import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { EnvironmentId, TrimmedString } from "./baseSchemas.ts";

/**
 * Sandbox providers are provisioned by the server a client is already connected to. The
 * provider's API key is saved in that server's settings, so an environment can be created from
 * any client without ever sending its key to the other machines on the account.
 */
export const SandboxProviderKind = Schema.Literals(["boat", "daytona"]);
export type SandboxProviderKind = typeof SandboxProviderKind.Type;

export const SandboxMachineSize = Schema.Struct({
  id: TrimmedString,
  label: TrimmedString,
  detail: TrimmedString,
});
export type SandboxMachineSize = typeof SandboxMachineSize.Type;

export const SandboxProviderInfo = Schema.Struct({
  kind: SandboxProviderKind,
  label: TrimmedString,
  detail: TrimmedString,
  apiKeyLabel: TrimmedString,
  apiKeyPlaceholder: TrimmedString,
  docsUrl: TrimmedString,
  /** False until an API key is saved on this server. */
  configured: Schema.Boolean,
  sizes: Schema.Array(SandboxMachineSize),
  /** Derived from the optional methods the driver implements, so clients never branch on `kind`. */
  capabilities: Schema.Struct({
    limits: Schema.Boolean,
    stopResume: Schema.Boolean,
    credentialEnvironments: Schema.Boolean,
  }),
});
export type SandboxProviderInfo = typeof SandboxProviderInfo.Type;

export const SandboxProvidersResult = Schema.Struct({
  providers: Schema.Array(SandboxProviderInfo),
});
export type SandboxProvidersResult = typeof SandboxProvidersResult.Type;

/**
 * A provider-side environment is the only supported way to give a sandbox credentials. It
 * decides whether the provider passes its GitHub token, secrets, and agent logins; T3 never
 * reads or forwards those values itself.
 */
export const SandboxCredentialEnvironment = Schema.Struct({
  name: TrimmedString,
  isDefault: Schema.Boolean,
  safeForThirdParties: Schema.Boolean,
  passGithub: Schema.Boolean,
  passSecrets: Schema.Boolean,
  passSandboxCredentials: Schema.Boolean,
  passAgentsCredentials: Schema.Boolean,
  proxyAiCredentials: Schema.Boolean,
});
export type SandboxCredentialEnvironment = typeof SandboxCredentialEnvironment.Type;

export const SandboxCredentialEnvironmentsInput = Schema.Struct({
  provider: SandboxProviderKind,
});
export type SandboxCredentialEnvironmentsInput = typeof SandboxCredentialEnvironmentsInput.Type;

export const SandboxCredentialEnvironmentsResult = Schema.Struct({
  environments: Schema.Array(SandboxCredentialEnvironment),
});
export type SandboxCredentialEnvironmentsResult = typeof SandboxCredentialEnvironmentsResult.Type;

export const SandboxStartWindow = Schema.Struct({
  window: Schema.Literals(["minute", "hour", "day"]),
  limit: Schema.Number,
  used: Schema.Number,
  remaining: Schema.Number,
  resetsAt: Schema.optionalKey(TrimmedString),
});
export type SandboxStartWindow = typeof SandboxStartWindow.Type;

/**
 * What the provider account allows right now, normalized across providers. Every field but
 * `canStart` is optional because providers report different subsets.
 */
export const SandboxProviderLimits = Schema.Struct({
  canStart: Schema.Boolean,
  blockedReason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300))),
  starts: Schema.optionalKey(Schema.Array(SandboxStartWindow)),
  concurrency: Schema.optionalKey(Schema.Struct({ active: Schema.Number, max: Schema.Number })),
  /** `refused` means the provider would reject the next start outright. */
  startCost: Schema.optionalKey(Schema.Literals(["included", "paid", "refused"])),
  startDollars: Schema.optionalKey(Schema.Number),
  maxTtlMinutes: Schema.optionalKey(Schema.Int),
  sizes: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: TrimmedString,
        available: Schema.Boolean,
        reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300))),
      }),
    ),
  ),
  plan: Schema.optionalKey(TrimmedString),
  billingUrl: Schema.optionalKey(TrimmedString),
});
export type SandboxProviderLimits = typeof SandboxProviderLimits.Type;

export const SandboxLimitsInput = Schema.Struct({
  provider: SandboxProviderKind,
});
export type SandboxLimitsInput = typeof SandboxLimitsInput.Type;

export const SandboxLimitsResult = Schema.Struct({
  /** Null when the provider cannot report limits; starting is then left to the provider. */
  limits: Schema.NullOr(SandboxProviderLimits),
});
export type SandboxLimitsResult = typeof SandboxLimitsResult.Type;

export const SandboxCreateInput = Schema.Struct({
  provider: SandboxProviderKind,
  /** Saved on this server when present; when omitted the saved key is used. */
  apiKey: Schema.optional(TrimmedString),
  /** Shown as the environment and sandbox name. Defaults to a generated name. */
  label: Schema.optional(TrimmedString),
  /** One of the provider's machine size ids. Defaults to the provider's default size. */
  size: Schema.optional(TrimmedString),
  /** Cloned into the sandbox before the environment is connected. */
  repositoryUrl: Schema.optional(TrimmedString),
  /** Provider environment whose credentials the sandbox receives. Omit for no credentials. */
  environment: Schema.optional(TrimmedString),
  /** Required with `environment`: the user confirmed that this environment passes credentials. */
  allowCredentials: Schema.optional(Schema.Boolean),
  /** Stop the machine after this many minutes. Omit to leave the provider default. */
  ttlMinutes: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 43200 }))),
});
export type SandboxCreateInput = typeof SandboxCreateInput.Type;

export const SandboxCreateResult = Schema.Struct({
  provider: SandboxProviderKind,
  sandboxId: TrimmedString,
  environmentId: EnvironmentId,
  label: TrimmedString,
  /** Public origin of the T3 server running in the sandbox. */
  httpBaseUrl: TrimmedString,
  /** One-time pairing code, consumed by the client that connects to the new environment. */
  pairingCode: TrimmedString,
});
export type SandboxCreateResult = typeof SandboxCreateResult.Type;

export const SandboxDeleteInput = Schema.Struct({
  provider: SandboxProviderKind,
  sandboxId: TrimmedString,
  environmentId: EnvironmentId,
});
export type SandboxDeleteInput = typeof SandboxDeleteInput.Type;

export const SandboxLifecycleState = Schema.Literals([
  "provisioning",
  "running",
  "stopped",
  "error",
  "deleted",
]);
export type SandboxLifecycleState = typeof SandboxLifecycleState.Type;

/** Server-side record that ties a provider machine to the T3 environment it became. */
export const SandboxRecord = Schema.Struct({
  environmentId: EnvironmentId,
  provider: SandboxProviderKind,
  sandboxId: TrimmedString,
  label: TrimmedString,
  size: TrimmedString,
  state: SandboxLifecycleState,
  createdAt: TrimmedString,
  updatedAt: TrimmedString,
  httpBaseUrl: TrimmedString,
  /** Null disables the hard deadline. */
  hardDeadlineAt: Schema.NullOr(TrimmedString),
  ttlMinutes: Schema.Int,
  credentialEnvironment: Schema.optionalKey(TrimmedString),
});
export type SandboxRecord = typeof SandboxRecord.Type;

export const SandboxListResult = Schema.Struct({
  sandboxes: Schema.Array(SandboxRecord),
});
export type SandboxListResult = typeof SandboxListResult.Type;

export const SandboxLifecycleInput = Schema.Struct({
  environmentId: EnvironmentId,
});
export type SandboxLifecycleInput = typeof SandboxLifecycleInput.Type;

export const SandboxStopResult = Schema.Struct({
  sandbox: SandboxRecord,
});
export type SandboxStopResult = typeof SandboxStopResult.Type;

export const SandboxResumeResult = Schema.Struct({
  sandbox: SandboxRecord,
  httpBaseUrl: TrimmedString,
});
export type SandboxResumeResult = typeof SandboxResumeResult.Type;

export const SandboxStage = Schema.Literals([
  "create",
  "install",
  "start",
  "expose",
  "pair",
  "delete",
  "config",
]);
export type SandboxStage = typeof SandboxStage.Type;

export const SandboxProviderErrorCode = Schema.Literals([
  "api_key_rejected",
  "rate_limited",
  "concurrency_full",
  "billing_required",
  "size_unavailable",
  "snapshot_expired",
  "capacity_unavailable",
  "not_found",
  "unknown",
]);
export type SandboxProviderErrorCode = typeof SandboxProviderErrorCode.Type;

export class SandboxProviderError extends Schema.TaggedError<SandboxProviderError>()(
  "SandboxProviderError",
  {
    provider: SandboxProviderKind,
    stage: SandboxStage,
    /**
     * Bounded, human-readable reason shown to the user. Never a raw provider response body or
     * remote command output: those can carry credentials.
     */
    detail: Schema.String,
    /** The provider's HTTP status when the failure came from a response. */
    status: Schema.optional(Schema.Number),
    /** Stable category for provider refusals, so clients can react without parsing `detail`. */
    code: Schema.optional(SandboxProviderErrorCode),
    retryAfterSeconds: Schema.optional(Schema.Number),
    /** The exact underlying error or output, kept out of `message` and out of logs. */
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `${this.provider}: ${this.detail}`;
  }
}

export const isSandboxProviderError = Schema.is(SandboxProviderError);

const formatWait = (seconds: number): string =>
  seconds < 90
    ? `${Math.max(1, Math.round(seconds))} s`
    : seconds < 5400
      ? `${Math.round(seconds / 60)} min`
      : `${Math.round(seconds / 360) / 10} h`;

/** "Try again in 12 min." or an empty string, for messages that know when a limit frees up. */
export const describeSandboxRetry = (retryAfterSeconds: number | undefined): string =>
  retryAfterSeconds === undefined || retryAfterSeconds <= 0
    ? ""
    : ` Try again in ${formatWait(retryAfterSeconds)}.`;

export interface SandboxStartAssessment {
  readonly blocked: {
    readonly code: SandboxProviderErrorCode;
    readonly reason: string;
    readonly retryAfterSeconds?: number;
  } | null;
  /** Starts the provider accepts but the user should confirm: paid, nearly out, last slot. */
  readonly warnings: ReadonlyArray<string>;
}

/**
 * The one place that decides whether a start is blocked or only needs a confirmation. The server
 * enforces `blocked`; clients show both. Unknown fields never block.
 */
export const assessSandboxStart = (
  limits: SandboxProviderLimits,
  options: { readonly providerLabel: string; readonly size?: string; readonly nowMillis: number },
): SandboxStartAssessment => {
  const fullWindow = limits.starts?.find((window) => window.remaining <= 0);
  const secondsUntil = (iso: string | undefined) => {
    if (iso === undefined) return undefined;
    const millis = Date.parse(iso);
    return Number.isNaN(millis)
      ? undefined
      : Math.max(0, Math.ceil((millis - options.nowMillis) / 1000));
  };
  const size =
    options.size === undefined
      ? undefined
      : limits.sizes?.find((entry) => entry.id === options.size);
  const concurrencyFull =
    limits.concurrency !== undefined && limits.concurrency.active >= limits.concurrency.max;

  const blocked = ((): SandboxStartAssessment["blocked"] => {
    if (!limits.canStart) {
      return {
        code: "billing_required",
        reason:
          limits.blockedReason ??
          `${options.providerLabel} is not accepting new starts on this account.`,
      };
    }
    if (size !== undefined && !size.available) {
      return {
        code: "size_unavailable",
        reason:
          size.reason ??
          `This machine size is not available on your ${options.providerLabel} plan.`,
      };
    }
    if (concurrencyFull) {
      return {
        code: "concurrency_full",
        reason: `All ${limits.concurrency!.max} of your ${options.providerLabel} sandbox slots are in use. Stop or delete one first.`,
      };
    }
    if (limits.startCost === "refused") {
      if (fullWindow === undefined) {
        return {
          code: "billing_required",
          reason: `${options.providerLabel} would refuse the next start on this account.`,
        };
      }
      const retryAfterSeconds = secondsUntil(fullWindow.resetsAt);
      return {
        code: "rate_limited",
        reason: `${options.providerLabel}'s start limit for this ${fullWindow.window} is used up.${describeSandboxRetry(retryAfterSeconds)}`,
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      };
    }
    return null;
  })();
  if (blocked !== null) return { blocked, warnings: [] };

  const warnings: Array<string> = [];
  if (limits.startCost === "paid") {
    warnings.push(
      limits.startDollars === undefined
        ? `This start is past your plan's limits and will be charged.`
        : `This start will be charged about $${limits.startDollars.toFixed(2)}.`,
    );
  }
  const lowWindow = limits.starts?.find(
    (window) =>
      window.remaining > 0 && window.remaining <= Math.max(2, Math.ceil(window.limit / 10)),
  );
  if (lowWindow !== undefined) {
    warnings.push(
      `Only ${lowWindow.remaining} ${lowWindow.remaining === 1 ? "start" : "starts"} left this ${lowWindow.window}.`,
    );
  }
  if (
    limits.concurrency !== undefined &&
    limits.concurrency.active === limits.concurrency.max - 1
  ) {
    warnings.push(
      `This uses your last free slot (${limits.concurrency.active} of ${limits.concurrency.max} running).`,
    );
  }
  return { blocked: null, warnings };
};

export const SandboxSettings = Schema.Struct({
  apiKey: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey({ settingsSecret: true }),
  ),
});
export type SandboxSettings = typeof SandboxSettings.Type;
