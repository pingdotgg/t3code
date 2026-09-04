import {
  type OmpSettings,
  type ProviderOptionSelection,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import { resolveOmpAcpConfigUpdates } from "../Layers/OmpProvider.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

type OmpAcpRuntimeOmpSettings = Pick<OmpSettings, "binaryPath">;

export interface OmpAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly ompSettings: OmpAcpRuntimeOmpSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
  /**
   * Whether to advertise form elicitation support (default true). Callers
   * that register no elicitation handler (e.g. unattended text generation)
   * must pass false: omp's uiContext.select then resolves immediately with
   * undefined (a fast, clear refusal) instead of waiting on a channel nobody
   * answers.
   */
  readonly enableElicitation?: boolean;
}

export interface OmpAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly step: "set-config-option";
  readonly configId?: string;
}

/**
 * RuntimeMode is a spawn-time concern for `omp acp`: approval behavior is
 * selected through CLI flags (verified against omp/18.0.6), not through an
 * in-session ACP mechanism. `always-ask` is passed explicitly for
 * approval-required because bare `acp` inherits the user's own
 * `tools.approvalMode` config, which may be `yolo` — Supervised must not
 * silently inherit it.
 */
export function ompAcpSpawnArgs(runtimeMode?: RuntimeMode): ReadonlyArray<string> {
  switch (runtimeMode) {
    case "auto-accept-edits":
      return ["acp", "--approval-mode=write"];
    case "auto":
      return ["acp", "--auto-approve"];
    case "full-access":
      return ["acp", "--approval-mode=yolo"];
    case "approval-required":
    default:
      return ["acp", "--approval-mode=always-ask"];
  }
}

export function buildOmpAcpSpawnInput(
  ompSettings: OmpAcpRuntimeOmpSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  runtimeMode?: RuntimeMode,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: ompSettings?.binaryPath || "omp",
    args: [...ompAcpSpawnArgs(runtimeMode)],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeOmpAcpRuntime = (
  input: OmpAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildOmpAcpSpawnInput(
          input.ompSettings,
          input.cwd,
          input.environment,
          input.runtimeMode,
        ),
        // omp/18.0.6 advertises exactly one auth method ("Use existing local
        // credentials"); credentials live under ~/.omp.
        authMethodId: "agent",
        // omp routes its second approval layer (extension wrapper, anything
        // short of yolo) through session/elicitation, and only when the
        // client declares form elicitation — undeclared reads as Deny.
        ...(input.enableElicitation === false
          ? {}
          : { clientCapabilities: { elicitation: { form: {} } } }),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

interface OmpAcpModelSelectionRuntime {
  readonly getConfigOptions: AcpSessionRuntime.AcpSessionRuntime["Service"]["getConfigOptions"];
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

/**
 * Applies the requested model and provider options through omp's
 * `session/set_config_option` mechanism. There is no static default model
 * id for omp: when no model is requested, nothing is written and the CLI's
 * current config value wins.
 */
export function applyOmpAcpModelSelection<E>(input: {
  readonly runtime: OmpAcpModelSelectionRuntime;
  readonly model: string | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (context: OmpAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    const requestedModel = resolveOmpAcpBaseModelId(input.model);
    // Model first, then re-read config options: omp re-validates dependent
    // selects per model (e.g. `thinking` accepts off/auto under `auto` but
    // off/low/medium/high/max elsewhere), so validating against the
    // pre-switch options writes values the session then rejects.
    if (requestedModel !== undefined) {
      const configOptions = yield* input.runtime.getConfigOptions;
      const modelConfigId =
        configOptions.find((option) => option.category?.trim().toLowerCase() === "model")?.id ??
        configOptions.find((option) => option.id.trim().toLowerCase() === "model")?.id ??
        "model";
      yield* input.runtime
        .setConfigOption(modelConfigId, requestedModel)
        .pipe(
          Effect.mapError((cause) =>
            input.mapError({ cause, step: "set-config-option", configId: modelConfigId }),
          ),
        );
    }
    const configOptions = yield* input.runtime.getConfigOptions;
    for (const update of resolveOmpAcpConfigUpdates(configOptions, input.selections)) {
      yield* input.runtime.setConfigOption(update.configId, update.value).pipe(
        Effect.mapError((cause) =>
          input.mapError({
            cause,
            step: "set-config-option",
            configId: update.configId,
          }),
        ),
      );
    }
  });
}

export function resolveOmpAcpBaseModelId(model: string | null | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) {
    return undefined;
  }
  const base = trimmed.includes("[") ? trimmed.slice(0, trimmed.indexOf("[")) : trimmed;
  return base.length > 0 ? base : undefined;
}
