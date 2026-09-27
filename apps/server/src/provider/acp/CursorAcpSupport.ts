import {
  type CursorSettings,
  type ProviderOptionSelection,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
  resolveCursorAcpBaseModelId,
  resolveCursorAcpConfigUpdates,
} from "../Layers/CursorProvider.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

type CursorAcpRuntimeCursorSettings = Pick<CursorSettings, "apiEndpoint" | "binaryPath">;

function cursorAcpPermissionArgs(runtimeMode?: RuntimeMode): ReadonlyArray<string> {
  switch (runtimeMode) {
    case "auto":
      return ["--auto-review"];
    case "full-access":
      return ["--force"];
    default:
      return [];
  }
}

export interface CursorAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly cursorSettings: CursorAcpRuntimeCursorSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
}

export interface CursorAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly step: "set-config-option" | "set-model";
  readonly configId?: string;
}

export function buildCursorAcpSpawnInput(
  cursorSettings: CursorAcpRuntimeCursorSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  runtimeMode?: RuntimeMode,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: cursorSettings?.binaryPath || "cursor-agent",
    args: [
      ...(cursorSettings?.apiEndpoint ? (["-e", cursorSettings.apiEndpoint] as const) : []),
      ...cursorAcpPermissionArgs(runtimeMode),
      "acp",
    ],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeCursorAcpRuntime = (
  input: CursorAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildCursorAcpSpawnInput(
          input.cursorSettings,
          input.cwd,
          input.environment,
          input.runtimeMode,
        ),
        authMethodId: "cursor_login",
        clientCapabilities: CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
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

interface CursorAcpModelSelectionRuntime {
  readonly getConfigOptions: AcpSessionRuntime.AcpSessionRuntime["Service"]["getConfigOptions"];
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
  readonly setModel: (model: string) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

export function applyCursorAcpModelSelection<E>(input: {
  readonly runtime: CursorAcpModelSelectionRuntime;
  readonly model: string | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (context: CursorAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    const requestedModel = resolveCursorAcpBaseModelId(input.model);
    yield* input.runtime.setModel(requestedModel).pipe(
      Effect.mapError((cause) =>
        input.mapError({
          cause,
          step: "set-model",
        }),
      ),
    );

    const configOptions = yield* input.runtime.getConfigOptions;
    // cursor-agent can accept the model change and still keep the previous
    // model. Refuse to continue so the prompt never runs on a model the user
    // did not pick.
    const currentModel = configOptions.find((option) => option.category === "model")?.currentValue;
    if (
      typeof currentModel === "string" &&
      resolveCursorAcpBaseModelId(currentModel) !== requestedModel
    ) {
      return yield* Effect.fail(
        input.mapError({
          cause: new EffectAcpErrors.AcpRequestError({
            code: -32603,
            errorMessage: `Cursor stayed on model "${currentModel}" instead of "${requestedModel}"; the prompt was not sent.`,
            method: "session/set_config_option",
          }),
          step: "set-model",
        }),
      );
    }

    const configUpdates = resolveCursorAcpConfigUpdates(configOptions, input.selections);
    for (const update of configUpdates) {
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
