import {
  type CopilotSettings,
  type ProviderOptionSelection,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import {
  resolveCopilotAcpBaseModelId,
  resolveCopilotAcpConfigUpdates,
} from "../Layers/CopilotProvider.ts";

export const COPILOT_AUTH_METHOD_ID = "copilot-login";
const COPILOT_DRIVER_KIND = ProviderDriverKind.make("copilot");

type CopilotAcpRuntimeCopilotSettings = Pick<CopilotSettings, "binaryPath">;

export interface CopilotAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly copilotSettings: CopilotAcpRuntimeCopilotSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface CopilotAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly step: "set-config-option" | "set-model";
  readonly configId?: string;
}

export function buildCopilotAcpSpawnInput(
  copilotSettings: CopilotAcpRuntimeCopilotSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: copilotSettings?.binaryPath || "copilot",
    args: ["--acp"],
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

export function currentCopilotModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export interface CopilotAcpModelSelectionRuntime {
  readonly getConfigOptions: Effect.Effect<
    ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
    EffectAcpErrors.AcpError
  >;
  readonly setConfigOption: (
    configId: string,
    value: string,
  ) => Effect.Effect<EffectAcpSchema.SetSessionConfigOptionResponse, EffectAcpErrors.AcpError>;
  readonly setModel: (model: string) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

export function applyCopilotAcpModelSelection<E>(input: {
  readonly runtime: CopilotAcpModelSelectionRuntime;
  readonly model: string | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (context: CopilotAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    yield* input.runtime.setModel(resolveCopilotAcpBaseModelId(input.model)).pipe(
      Effect.mapError((cause) =>
        input.mapError({
          cause,
          step: "set-model",
        }),
      ),
    );

    const configOptions = yield* input.runtime.getConfigOptions.pipe(
      Effect.mapError((cause) =>
        input.mapError({
          cause,
          step: "set-config-option",
        }),
      ),
    );
    const configUpdates = resolveCopilotAcpConfigUpdates(configOptions, input.selections);
    for (const update of configUpdates) {
      yield* input.runtime.setConfigOption(update.configId, String(update.value)).pipe(
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
