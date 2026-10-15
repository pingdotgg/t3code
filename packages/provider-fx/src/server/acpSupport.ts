import type * as EffectAcpSchema from "effect-acp/compat";
import {
  type ModelSelection,
  type ProviderOptionDescriptor,
  ProviderDriverKind,
  type RuntimeMode,
} from "@t3tools/contracts";
import type { FxSettings } from "../settings.ts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { collectSessionConfigOptionValues } from "@t3tools/provider-acp/server/runtimeModel";
import {
  acpPermissionDisposition,
  type AcpPermissionDisposition,
} from "@t3tools/provider-acp/server/clientPolicy";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

export const FX_DRIVER_KIND = ProviderDriverKind.make("fx");
/** T3's slug for "Default": the model `fx status` reports, never an fx model id. */
export const FX_DEFAULT_MODEL_SLUG = "default";
const FX_MODEL_CONFIG_ID = "model";
const FX_MODE_CONFIG_ID = "mode";
const FX_EFFORT_CONFIG_ID = "effort";
const FX_DEFAULT_EFFORT = "medium";

const FX_EFFORT_LABELS = {
  auto: "Auto",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
} as const;

export const FX_EFFORT_OPTION_DESCRIPTOR: ProviderOptionDescriptor = {
  id: FX_EFFORT_CONFIG_ID,
  label: "Effort",
  type: "select",
  options: Object.entries(FX_EFFORT_LABELS).map(([id, label]) => ({
    id,
    label,
    ...(id === FX_DEFAULT_EFFORT ? { isDefault: true } : {}),
  })),
};

export const FX_SUPPORTED_RUNTIME_MODES = [
  "approval-required",
  "auto",
] as const satisfies ReadonlyArray<RuntimeMode>;
/** fx 0.0.13 answers a cancelled prompt with `stopReason: cancelled`. */
export const FX_ACP_CANCEL_BEHAVIOR = "wait-for-prompt" as const;

/**
 * Supervised runs fx's `ask` mode and Auto its automatic review. An explicit
 * approval or sandbox policy must not launch automatic review, which would
 * perform writes the policy meant to confine.
 */
export function fxSessionModeForPolicy(
  policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
): "ask" | "auto" {
  return policy.runtimeMode === "auto" &&
    policy.approvalPolicy === undefined &&
    policy.sandboxPolicy === undefined
    ? "auto"
    : "ask";
}

/** In automatic review fx asks only about what it refused itself, so every prompt reaches the user. */
export function fxPermissionDisposition(
  policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
  request: EffectAcpSchema.RequestPermissionRequest,
): AcpPermissionDisposition {
  return fxSessionModeForPolicy(policy) === "auto"
    ? "ask"
    : acpPermissionDisposition({ ...policy, runtimeMode: "approval-required" }, request);
}

/**
 * fx's id for a requested mode, first advertised match wins. fx 0.0.13 calls
 * automatic review `code`; fx after vercel-labs/fx#1189 calls it `auto`.
 * `code` is also accepted as a request because the shared plan restore
 * passes a session's saved mode id back.
 */
function fxModeId(requested: string, advertised: ReadonlyArray<string>): string | undefined {
  const candidates =
    requested === "ask"
      ? ["ask"]
      : requested === "auto" || requested === "code"
        ? ["auto", "code"]
        : [];
  return candidates.find((id) => advertised.includes(id));
}

/**
 * fx 0.0.13 reports `ask` on a new or loaded session while enforcing its
 * saved default until a client writes the mode, and the runtime skips a
 * write that matches the reported mode. So the first mode write after a
 * session starts or loads always goes out; later ones (a model switch
 * reconfigures the session) take the runtime's path. A mode fx does not
 * advertise fails before anything is sent.
 */
export function withFxSessionMode(
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
): AcpSessionRuntime.AcpSessionRuntime["Service"] {
  let pendingSessionId: string | undefined;
  const activated = <E, R>(
    effect: Effect.Effect<AcpSessionRuntime.AcpSessionRuntimeStartResult, E, R>,
  ) =>
    effect.pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          pendingSessionId = result.sessionId;
        }),
      ),
    );
  return {
    ...runtime,
    start: () => activated(runtime.start()),
    loadSession: (sessionId, options) => activated(runtime.loadSession(sessionId, options)),
    resumeSession: (sessionId, options) => activated(runtime.resumeSession(sessionId, options)),
    forkSession: (sessionId, options) => activated(runtime.forkSession(sessionId, options)),
    setMode: (requested) =>
      Effect.gen(function* () {
        const state = yield* runtime.getModeState;
        const advertised = state?.availableModes.map((mode) => mode.id) ?? [];
        const target = fxModeId(requested, advertised);
        if (target === undefined) {
          return yield* new EffectAcpErrors.AcpRequestError({
            code: -32602,
            errorMessage: `fx cannot run in mode "${requested}"; it advertises ${advertised.join(", ") || "no modes"}.`,
            data: {
              configId: FX_MODE_CONFIG_ID,
              allowedValues: advertised,
              receivedValue: requested,
            },
          });
        }
        const sessionId = pendingSessionId;
        if (sessionId === undefined || state?.currentModeId !== target) {
          const response = yield* runtime.setMode(target);
          pendingSessionId = undefined;
          return response;
        }
        yield* runtime.request("session/set_config_option", {
          sessionId,
          configId: FX_MODE_CONFIG_ID,
          value: target,
        });
        // Only a write fx took counts, so a retried setup sends it again.
        pendingSessionId = undefined;
        return {};
      }),
  };
}

/**
 * fx lists its backend `provider` before `model`, both with category `model`,
 * so the write goes to config id `model`. "Default" selects the model `fx
 * status` reports, which the provider snapshot carries, when the session
 * lists it; otherwise the session keeps its model. A model the thread picked
 * is sent even when the session does not list it (a custom model): fx's
 * gateway takes any id, and its other backends refuse an unknown one with
 * their own error, so a thread never runs on a model it did not pick.
 */
export const applyFxModelSelection = (
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  modelSelection: ModelSelection,
  defaultModel: Effect.Effect<string | undefined> | undefined,
): Effect.Effect<string | undefined, EffectAcpErrors.AcpError> =>
  Effect.gen(function* () {
    const option = (yield* runtime.getConfigOptions).find(
      (entry) => entry.id === FX_MODEL_CONFIG_ID && entry.type === "select",
    );
    const current = option?.type === "select" ? option.currentValue : undefined;
    const requested = modelSelection.model.trim();
    const isDefault = requested.length === 0 || requested === FX_DEFAULT_MODEL_SLUG;
    const target = isDefault ? defaultModel && (yield* defaultModel) : requested;
    if (target === undefined || target === current) return current;
    // The status default can belong to another fx backend than the session's
    // (after `fx provider`, or a loaded older session); then the session's
    // own model stands.
    if (
      isDefault &&
      (option === undefined || !collectSessionConfigOptionValues(option).includes(target))
    ) {
      return current;
    }
    yield* runtime.setConfigOption(FX_MODEL_CONFIG_ID, target, { allowUnlistedValue: true });
    return target;
  });

/** The shared option loop writes a stored effort; a thread without one starts at medium. */
export const applyFxEffortDefault = (
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  modelSelection: ModelSelection,
): Effect.Effect<void, EffectAcpErrors.AcpError> =>
  Effect.gen(function* () {
    if (getModelSelectionStringOptionValue(modelSelection, FX_EFFORT_CONFIG_ID)) return;
    const option = (yield* runtime.getConfigOptions).find(
      (entry) => entry.id === FX_EFFORT_CONFIG_ID && entry.type === "select",
    );
    if (
      option !== undefined &&
      collectSessionConfigOptionValues(option).includes(FX_DEFAULT_EFFORT)
    ) {
      yield* runtime.setConfigOption(FX_EFFORT_CONFIG_ID, FX_DEFAULT_EFFORT);
    }
  });

interface FxAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn" | "cancelBehavior"
> {
  readonly fxSettings: Pick<FxSettings, "binaryPath">;
  readonly environment?: NodeJS.ProcessEnv;
}

export const makeFxAcpRuntime = (
  input: FxAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const { fxSettings, environment, ...runtimeOptions } = input;
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...runtimeOptions,
        spawn: {
          command: fxSettings.binaryPath || "fx",
          args: ["acp"],
          cwd: input.cwd,
          env: { ...environment },
        },
        cancelBehavior: FX_ACP_CANCEL_BEHAVIOR,
      }),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
  });
