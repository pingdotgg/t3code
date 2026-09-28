import { type DshSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { findSessionConfigOption } from "./AcpRuntimeModel.ts";

const DSH_MODEL_CONFIG_ID = "model";
const DSH_REASONING_CONFIG_ID = "reasoning_effort";

type DshAcpRuntimeDshSettings = Pick<DshSettings, "binaryPath">;

/**
 * DSH publishes its model catalog only through `session/new`/`session/resume`
 * configOptions. The `model` option's `currentValue` is the wire route
 * `JSON.stringify([provider, model])`; the `reasoning_effort` option only exists
 * for models that declare reasoning support and `""` means the provider default.
 */

export function dshAcpSpawnArgs(): ReadonlyArray<string> {
  return ["--profile", "acp"];
}

export function buildDshAcpSpawnInput(
  dshSettings: DshAcpRuntimeDshSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: dshSettings?.binaryPath || "dsh",
    args: dshAcpSpawnArgs(),
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export interface DshAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly dshSettings: DshAcpRuntimeDshSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export const makeDshAcpRuntime = (
  input: DshAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildDshAcpSpawnInput(input.dshSettings, input.cwd, input.environment),
        // DSH's authenticate always succeeds immediately and ignores the payload, so
        // the method id only needs to satisfy the ACP handshake.
        authMethodId: "dsh",
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

type DshSessionSetupResult =
  | EffectAcpSchema.LoadSessionResponse
  | EffectAcpSchema.NewSessionResponse
  | EffectAcpSchema.ResumeSessionResponse;

/** Wire value of the model route the session currently runs, if DSH advertises one. */
export function currentDshModelWireValueFromSessionSetup(
  sessionSetupResult: DshSessionSetupResult,
): string | undefined {
  const option = findSessionConfigOption(sessionSetupResult.configOptions, DSH_MODEL_CONFIG_ID);
  if (option?.type !== "select") {
    return undefined;
  }
  const currentValue = option.currentValue.trim();
  return currentValue.length > 0 ? currentValue : undefined;
}

/**
 * Current `reasoning_effort` value, if the session's model declares reasoning
 * support. `""` means the provider default; `undefined` means no such option.
 */
export function currentDshReasoningEffortFromSessionSetup(
  sessionSetupResult: DshSessionSetupResult,
): string | undefined {
  const option = findSessionConfigOption(sessionSetupResult.configOptions, DSH_REASONING_CONFIG_ID);
  if (option?.type !== "select") {
    return undefined;
  }
  return option.currentValue.trim();
}

interface DshAcpModelSelectionRuntime {
  readonly getConfigOptions: AcpSessionRuntime.AcpSessionRuntime["Service"]["getConfigOptions"];
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

export interface DshAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly configId: string;
}

/**
 * Applies a model selection to a running DSH session through ACP config options.
 * `currentModel` is the wire route from session setup; `requestedModel` is the
 * wire route to select (T3 slugs are the wire values verbatim). The reasoning
 * effort is only written when explicitly requested and the selected model still
 * advertises a `reasoning_effort` option.
 */
export function applyDshAcpModelSelection<E>(input: {
  readonly runtime: DshAcpModelSelectionRuntime;
  readonly currentModel?: string | undefined;
  readonly requestedModel?: string | undefined;
  readonly requestedReasoningEffort?: string | undefined;
  readonly mapError: (context: DshAcpModelSelectionErrorContext) => E;
}): Effect.Effect<string | undefined, E> {
  const currentModel = input.currentModel?.trim() || undefined;
  const requestedModel = input.requestedModel?.trim() || undefined;
  const targetModel = requestedModel ?? currentModel;
  const modelChanged = requestedModel !== undefined && requestedModel !== currentModel;
  const requestedReasoningEffort =
    input.requestedReasoningEffort !== undefined
      ? input.requestedReasoningEffort.trim()
      : undefined;
  return Effect.gen(function* () {
    if (modelChanged && targetModel !== undefined) {
      yield* input.runtime
        .setConfigOption(DSH_MODEL_CONFIG_ID, targetModel)
        .pipe(Effect.mapError((cause) => input.mapError({ cause, configId: DSH_MODEL_CONFIG_ID })));
    }
    if (requestedReasoningEffort !== undefined) {
      // Read the live options after the model switch so the effort write is only
      // attempted for models that actually advertise a reasoning_effort option.
      const options = yield* input.runtime.getConfigOptions;
      const effortOption = options.find((option) => option.id.trim() === DSH_REASONING_CONFIG_ID);
      if (
        effortOption?.type === "select" &&
        effortOption.currentValue.trim() !== requestedReasoningEffort
      ) {
        yield* input.runtime
          .setConfigOption(DSH_REASONING_CONFIG_ID, requestedReasoningEffort)
          .pipe(
            Effect.mapError((cause) =>
              input.mapError({ cause, configId: DSH_REASONING_CONFIG_ID }),
            ),
          );
      }
    }
    return targetModel;
  });
}
