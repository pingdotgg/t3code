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
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
  resolveCursorAcpBaseModelId,
  resolveCursorAcpConfigUpdates,
} from "../Layers/CursorProvider.ts";
import { collectSessionConfigOptionValues, findSessionConfigOption } from "./AcpRuntimeModel.ts";
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

function findCursorModelSelectOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): EffectAcpSchema.SessionConfigOption | undefined {
  const byId = findSessionConfigOption(configOptions, "model");
  if (byId?.type === "select") {
    return byId;
  }
  return configOptions?.find((option) => option.category === "model" && option.type === "select");
}

/** Fail before ACP when the id is outside cursor-agent's live account catalog. */
export function cursorAcpUnsupportedModelError(modelId: string): EffectAcpErrors.AcpRequestError {
  return new EffectAcpErrors.AcpRequestError({
    code: -32602,
    errorMessage: `Cursor CLI only runs models from your Cursor account catalog, so "${modelId}" cannot be used. OpenRouter and other BYOK model ids work in the Cursor IDE app, not through cursor-agent. Use an OpenCode provider instance with an OpenRouter model (for example openrouter/deepseek/deepseek-v4.1-flash), or pick a model from Cursor's catalog.`,
    data: { requestedModel: modelId },
    method: "session/set_model",
  });
}

/**
 * Map a requested model id onto a live Cursor catalog select value.
 * Catalog entries can be bare (`composer-2.5`) or parameterized
 * (`gpt-5.6-sol[context=272k,...]`); match on the base slug and return the
 * exact catalog value ACP expects for `setModel`.
 */
export function resolveCursorAcpCatalogModelId(
  allowedValues: ReadonlyArray<string>,
  model: string | null | undefined,
): string | undefined {
  const trimmed = model?.trim();
  if (trimmed && allowedValues.includes(trimmed)) {
    return trimmed;
  }
  const baseModelId = resolveCursorAcpBaseModelId(model);
  if (allowedValues.includes(baseModelId)) {
    return baseModelId;
  }
  return allowedValues.find((value) => resolveCursorAcpBaseModelId(value) === baseModelId);
}

export function applyCursorAcpModelSelection<E>(input: {
  readonly runtime: CursorAcpModelSelectionRuntime;
  readonly model: string | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (context: CursorAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    const baseModelId = resolveCursorAcpBaseModelId(input.model);
    const configOptions = yield* input.runtime.getConfigOptions;
    const modelOption = findCursorModelSelectOption(configOptions);
    let modelId = baseModelId;
    if (modelOption?.type === "select") {
      const allowedValues = collectSessionConfigOptionValues(modelOption);
      if (allowedValues.length > 0) {
        const matched = resolveCursorAcpCatalogModelId(allowedValues, input.model);
        if (!matched) {
          return yield* Effect.fail(
            input.mapError({
              cause: cursorAcpUnsupportedModelError(baseModelId),
              step: "set-model",
            }),
          );
        }
        modelId = matched;
      }
    }

    yield* input.runtime.setModel(modelId).pipe(
      Effect.mapError((cause) =>
        input.mapError({
          cause,
          step: "set-model",
        }),
      ),
    );

    // setModel refreshes model-specific options; use the post-switch snapshot.
    const configUpdates = resolveCursorAcpConfigUpdates(
      yield* input.runtime.getConfigOptions,
      input.selections,
    );
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
