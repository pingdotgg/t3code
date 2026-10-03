import type * as EffectAcpSchema from "effect-acp/compat";
import type { KiroSettings, ProviderApprovalOption, RuntimeMode } from "@t3tools/contracts";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import {
  acpPermissionDisposition,
  type AcpPermissionDisposition,
  type AcpRuntimePolicy,
} from "./AcpClientPolicy.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

/**
 * CLI V3 runs only when asked for (`--agent-engine=v3`); the default engine is
 * the v2 server this driver does not speak. `--auth-method=cli` keeps access
 * tokens inside the Kiro process, so T3 never handles them and Kiro never sends
 * `_kiro/auth/getAccessToken` (the shared ACP client answers that, like every
 * request without a handler, with a JSON-RPC method-not-found error).
 * V3 rejects the v2 launch flags (`--agent`, `--model`, `--trust-*`); mode and
 * model are chosen per session through `session/set_config_option`.
 */
const KIRO_ACP_ARGS = ["acp", "--agent-engine=v3", "--auth-method=cli"] as const;

/**
 * Kiro's `autopilot` session option. Kiro 2.27 asks the client before a tool
 * call either way; with it "off" (Supervised) it also asks the user to review
 * a turn's file changes before it ends ("Review changes", a `turn_approval`
 * permission request). Kiro starts sessions on "on", so T3 sets it from the
 * thread's runtime mode.
 */
export const KIRO_AUTOPILOT_CONFIG_ID = "autopilot";

/** Kiro's model session option (`configId: "model"` in the V3 migration guide). */
export const KIRO_MODEL_CONFIG_ID = "model";

/**
 * Kiro offers two permission postures, Supervised and Autopilot, which T3's
 * Supervised and Full access select. Any other mode runs Supervised.
 */
export const KIRO_SUPPORTED_RUNTIME_MODES = [
  "approval-required",
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;

/**
 * Autopilot is on only for an unrestricted Full access thread. An explicit
 * approval or sandbox override keeps Kiro Supervised, so its end-of-turn
 * review still reaches the user and every tool prompt reaches T3's policy
 * check (the same rule as Grok's `grokLaunchRuntimeMode`).
 */
export function kiroAutopilotValue(policy: {
  readonly runtimeMode: RuntimeMode;
  readonly approvalPolicy?: unknown;
  readonly sandboxPolicy?: unknown;
}): "on" | "off" {
  return policy.runtimeMode === "full-access" &&
    policy.approvalPolicy === undefined &&
    policy.sandboxPolicy === undefined
    ? "on"
    : "off";
}

type KiroAcpRuntimeSettings = Pick<KiroSettings, "binaryPath">;

export function buildKiroAcpSpawnInput(
  settings: KiroAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: settings?.binaryPath || "kiro-cli",
    args: [...KIRO_ACP_ARGS],
    cwd,
    ...(environment === undefined ? {} : { env: environment }),
  };
}

/**
 * Approval choices a Kiro permission request can honor. V3 sends its options
 * as authoritative, so only the kinds it offered appear. `allow_always` in V3
 * persists a consent rule (workspace or wider) rather than a session grant, so
 * it is not offered as "this session".
 */
export function kiroApprovalOptions(
  request: EffectAcpSchema.RequestPermissionRequest,
): ReadonlyArray<ProviderApprovalOption> {
  const has = (kind: EffectAcpSchema.PermissionOption["kind"]) =>
    request.options.some((option) => option.kind === kind && option.optionId.trim().length > 0);
  return [
    ...(has("allow_once") ? [{ decision: "accept", label: "Allow once" } as const] : []),
    ...(has("reject_once") ? [{ decision: "decline", label: "Deny" } as const] : []),
    { decision: "cancel", label: "Cancel" },
  ];
}

/**
 * T3's answer to a Kiro permission request. A policy approval may only use
 * Kiro's `allow_once`: its `allow_always` saves a consent rule for the whole
 * workspace or wider, which would outlive the thread. When Kiro offers no
 * one-time choice, the request goes to the user instead of persisting a grant.
 */
export function kiroPermissionDisposition(
  policy: AcpRuntimePolicy,
  request: EffectAcpSchema.RequestPermissionRequest,
): AcpPermissionDisposition {
  const disposition = acpPermissionDisposition(policy, request);
  const offersOnce = request.options.some(
    (option) => option.kind === "allow_once" && option.optionId.trim().length > 0,
  );
  return disposition === "allow" && !offersOnce ? "ask" : disposition;
}

export interface KiroAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly settings: KiroAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export const makeKiroAcpRuntime = (
  input: KiroAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const { childProcessSpawner, settings, environment, ...runtimeOptions } = input;
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...runtimeOptions,
        spawn: buildKiroAcpSpawnInput(settings, input.cwd, environment),
      }).pipe(
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner)),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
  });
