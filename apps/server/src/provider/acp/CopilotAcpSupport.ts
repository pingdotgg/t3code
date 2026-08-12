import {
  type CopilotSettings,
  type ProviderInteractionMode,
  type ProviderOptionSelection,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import type { AcpSessionModeState } from "./AcpRuntimeModel.ts";

export const COPILOT_AUTH_METHOD_ID = "copilot-login";
const DEFAULT_COPILOT_MODEL = "auto";

type CopilotAcpRuntimeSettings = Pick<CopilotSettings, "binaryPath">;

export interface CopilotAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly copilotSettings: CopilotAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildCopilotAcpSpawnInput(
  copilotSettings: CopilotAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: copilotSettings?.binaryPath || "copilot",
    args: ["--acp", "--stdio", "--no-auto-update"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeCopilotAcpRuntime = (
  input: CopilotAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildCopilotAcpSpawnInput(input.copilotSettings, input.cwd, input.environment),
        authMethodId: COPILOT_AUTH_METHOD_ID,
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

export function resolveCopilotModelId(model: string | null | undefined): string {
  return model?.trim() || DEFAULT_COPILOT_MODEL;
}

export function currentCopilotModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

function selectedString(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  id: string,
): string | undefined {
  const value = selections?.find((selection) => selection.id === id)?.value;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function hasConfigOption(
  options: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  id: string,
): boolean {
  return options.some((option) => option.id === id);
}

export function applyCopilotSessionConfiguration<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "getConfigOptions" | "setConfigOption" | "setModel"
  >;
  readonly model: string | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (context: {
    readonly cause: EffectAcpErrors.AcpError;
    readonly method: "session/set_config_option";
    readonly configId: string;
  }) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    if (input.model?.trim()) {
      const model = resolveCopilotModelId(input.model);
      if (model !== "auto" && model !== "default") {
        yield* input.runtime
          .setModel(model)
          .pipe(
            Effect.mapError((cause) =>
              input.mapError({ cause, method: "session/set_config_option", configId: "model" }),
            ),
          );
      }
    }

    const configOptions = yield* input.runtime.getConfigOptions;
    const reasoningEffort = selectedString(input.selections, "reasoningEffort");
    if (reasoningEffort && hasConfigOption(configOptions, "reasoning_effort")) {
      yield* input.runtime.setConfigOption("reasoning_effort", reasoningEffort).pipe(
        Effect.mapError((cause) =>
          input.mapError({
            cause,
            method: "session/set_config_option",
            configId: "reasoning_effort",
          }),
        ),
      );
    }
  });
}

function findMode(
  modeState: AcpSessionModeState | undefined,
  names: ReadonlyArray<string>,
): string | undefined {
  if (!modeState) return undefined;
  const aliases = new Set(names.map((name) => name.toLowerCase()));
  return modeState.availableModes.find(
    (mode) => aliases.has(mode.id.toLowerCase()) || aliases.has(mode.name.toLowerCase()),
  )?.id;
}

export function resolveCopilotModeId(input: {
  readonly modeState: AcpSessionModeState | undefined;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly runtimeMode: RuntimeMode;
}): string | undefined {
  return findMode(input.modeState, ["agent"]) ?? input.modeState?.currentModeId;
}
