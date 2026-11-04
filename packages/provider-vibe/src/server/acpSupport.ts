import { ProviderDriverKind, type RuntimeMode } from "@t3tools/contracts";
import type { VibeSettings } from "../settings.ts";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type { AcpAdapterV2ExtensionContext } from "@t3tools/provider-acp/server/adapter";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";

export const VIBE_DRIVER_KIND = ProviderDriverKind.make("vibe");
/** T3's slug for "Default": the session keeps Vibe's own active model. */
export const VIBE_DEFAULT_MODEL_SLUG = "default";
export const VIBE_MODE_CONFIG_ID = "mode";

/**
 * Vibe's agents are permission profiles. Smart Approve, the match for Auto,
 * ships hidden behind Vibe configuration, so Auto is not offered.
 */
export const VIBE_SUPPORTED_RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;

const VIBE_MODE_BY_RUNTIME_MODE = {
  "approval-required": "ask",
  "auto-accept-edits": "accept-edits",
  "full-access": "auto-approve",
} as const satisfies Record<(typeof VIBE_SUPPORTED_RUNTIME_MODES)[number], string>;

/**
 * An explicit approval or sandbox policy keeps Vibe on `ask`, so every tool
 * call reaches T3's policy check instead of Vibe approving it itself.
 */
export function vibeSessionModeForPolicy(
  policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
): string {
  if (policy.approvalPolicy !== undefined || policy.sandboxPolicy !== undefined) return "ask";
  const mode = VIBE_SUPPORTED_RUNTIME_MODES.find((supported) => supported === policy.runtimeMode);
  return mode === undefined ? "ask" : VIBE_MODE_BY_RUNTIME_MODE[mode];
}

export function vibeRuntimeModeForSessionMode(modeId: string): RuntimeMode | undefined {
  return VIBE_SUPPORTED_RUNTIME_MODES.find((mode) => VIBE_MODE_BY_RUNTIME_MODE[mode] === modeId);
}

/** Vibe answers a cancelled prompt with `stopReason: cancelled`. */
const VIBE_ACP_CANCEL_BEHAVIOR = "wait-for-prompt" as const;

// Mistral Vibe's application rate-limit code, outside ACP.
const VIBE_RATE_LIMITED = -31001;
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

const VibeSessionRetrying = Schema.Struct({
  sessionId: Schema.String,
  category: Schema.Literals(["rate_limited", "server_error", "timed_out", "connection", "unknown"]),
  detail: Schema.String,
});

/** Vibe reports its SDK backoff through this ACP extension. */
export function registerVibeAcpExtensions(context: AcpAdapterV2ExtensionContext) {
  return context.runtime.handleExtNotification("_session/retrying", VibeSessionRetrying, (notice) =>
    context.reportProviderRetry({
      sessionId: notice.sessionId,
      failure: makeProviderFailure({
        message: notice.detail,
        class:
          notice.category === "rate_limited"
            ? "usage_limit"
            : notice.category === "unknown"
              ? "provider_error"
              : "transport_error",
        retryable: true,
      }),
    }),
  );
}

export function vibePromptFailure(cause: unknown) {
  return makeProviderFailure({
    cause,
    ...(isAcpRequestError(cause)
      ? {
          message: cause.errorMessage,
          code: String(cause.code),
          class:
            cause.code === VIBE_RATE_LIMITED
              ? ("usage_limit" as const)
              : ("provider_error" as const),
        }
      : { class: "provider_error" as const }),
  });
}

interface VibeAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn" | "cancelBehavior"
> {
  readonly settings: Pick<VibeSettings, "binaryPath">;
  readonly environment?: NodeJS.ProcessEnv;
}

export const makeVibeAcpRuntime = Effect.fn("makeVibeAcpRuntime")(function* (
  input: VibeAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom | Scope.Scope
> {
  const { settings, environment, ...runtimeOptions } = input;
  const context = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...runtimeOptions,
      spawn: {
        command: settings.binaryPath || "vibe-acp",
        args: [],
        cwd: input.cwd,
        env: { ...environment },
      },
      cancelBehavior: VIBE_ACP_CANCEL_BEHAVIOR,
    }),
  );
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
});
