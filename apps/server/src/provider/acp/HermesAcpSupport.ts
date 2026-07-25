import { type HermesSettings, type ModelSelection, type RuntimeMode } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

export const HERMES_DEFAULT_MODEL = "hermes-default";
const HERMES_AUTH_METHOD_ID = "hermes-setup";

type HermesAcpRuntimeSettings = Pick<HermesSettings, "binaryPath">;

export interface HermesAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly hermesSettings: HermesAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildHermesAcpSpawnInput(
  hermesSettings: HermesAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: hermesSettings?.binaryPath || "hermes",
    args: ["acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeHermesAcpRuntime = (
  input: HermesAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildHermesAcpSpawnInput(input.hermesSettings, input.cwd, input.environment),
        // Hermes always advertises this terminal-setup method. Once Hermes
        // has a configured runtime provider, authenticating it is a no-op.
        authMethodId: HERMES_AUTH_METHOD_ID,
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

export function currentHermesModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  const modelId = sessionSetupResult.models?.currentModelId;
  return modelId?.trim() ? modelId : undefined;
}

export function resolveHermesRequestedModelId(
  model: string | null | undefined,
): string | undefined {
  if (typeof model !== "string") {
    return undefined;
  }
  const trimmed = model.trim();
  return !trimmed || trimmed === HERMES_DEFAULT_MODEL ? undefined : model;
}

export function resolveHermesAcpConfigUpdates(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  selections: ModelSelection["options"] | null | undefined,
): ReadonlyArray<{ readonly configId: string; readonly value: string | boolean }> {
  if (!configOptions?.length || !selections?.length) {
    return [];
  }
  const updates: Array<{ readonly configId: string; readonly value: string | boolean }> = [];
  for (const selection of selections) {
    const advertised = configOptions.find((option) => option.id === selection.id);
    if (!advertised) {
      continue;
    }
    if (advertised.type === "boolean") {
      if (typeof selection.value === "boolean") {
        updates.push({ configId: advertised.id, value: selection.value });
      }
      continue;
    }
    if (
      typeof selection.value === "string" &&
      advertised.options.some((entry) =>
        "value" in entry
          ? entry.value === selection.value
          : entry.options.some((option) => option.value === selection.value),
      )
    ) {
      updates.push({ configId: advertised.id, value: selection.value });
    }
  }
  return updates;
}

export function applyHermesAcpSelection<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "getConfigOptions" | "setConfigOption" | "setSessionModel"
  >;
  readonly currentModelId: string | undefined;
  readonly selection: Pick<ModelSelection, "model" | "options"> | undefined;
  readonly forceModelSelection?: boolean;
  readonly mapError: (input: {
    readonly cause: EffectAcpErrors.AcpError;
    readonly method: "session/set_config_option" | "session/set_model";
  }) => E;
}): Effect.Effect<string | undefined, E> {
  return Effect.gen(function* () {
    const requestedModelId = resolveHermesRequestedModelId(input.selection?.model);
    let currentModelId = input.currentModelId;
    if (
      requestedModelId !== undefined &&
      (input.forceModelSelection === true || requestedModelId !== currentModelId)
    ) {
      yield* input.runtime.setSessionModel(requestedModelId).pipe(
        Effect.mapError((cause) =>
          input.mapError({
            cause,
            method: "session/set_model",
          }),
        ),
      );
      currentModelId = requestedModelId;
    }

    if (!input.selection?.options?.length) {
      return currentModelId;
    }

    const configUpdates = resolveHermesAcpConfigUpdates(
      yield* input.runtime.getConfigOptions,
      input.selection.options,
    );
    for (const update of configUpdates) {
      yield* input.runtime.setConfigOption(update.configId, update.value).pipe(
        Effect.mapError((cause) =>
          input.mapError({
            cause,
            method: "session/set_config_option",
          }),
        ),
      );
    }
    return currentModelId;
  });
}

export function applyHermesRuntimeMode<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionMode">;
  readonly runtimeMode: RuntimeMode;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<void, E> {
  const modeId =
    input.runtimeMode === "approval-required"
      ? "default"
      : input.runtimeMode === "auto-accept-edits"
        ? "accept_edits"
        : "dont_ask";
  return input.runtime.setSessionMode(modeId).pipe(Effect.mapError(input.mapError), Effect.asVoid);
}
