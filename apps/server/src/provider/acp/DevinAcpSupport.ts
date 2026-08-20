import { type DevinSettings, type ProviderOptionSelection } from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

type DevinAcpRuntimeSettings = Pick<
  DevinSettings,
  | "acpArgs"
  | "agentConfigPath"
  | "agentType"
  | "binaryPath"
  | "configPath"
  | "launchArgs"
  | "respectWorkspaceTrust"
  | "sandbox"
>;

export interface DevinAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly devinSettings: DevinAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface DevinAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly configId?: string;
}

/**
 * Devin only sends `ask_user_question` prompts when the client advertises
 * form elicitation; without it the tool is disabled for the session.
 */
export const DEVIN_CLIENT_CAPABILITIES = {
  elicitation: { form: {} },
  _meta: {
    parameterizedModelPicker: true,
  },
} satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;

export function buildDevinGlobalArgs(
  settings: DevinAcpRuntimeSettings | null | undefined,
): ReadonlyArray<string> {
  return [
    ...(settings?.configPath ? ["--config", settings.configPath] : []),
    ...(settings?.agentConfigPath ? ["--agent-config", settings.agentConfigPath] : []),
    ...(settings?.sandbox ? ["--sandbox"] : []),
    ...(settings ? ["--respect-workspace-trust", String(settings.respectWorkspaceTrust)] : []),
    ...tokenizeCliArgs(settings?.launchArgs),
  ];
}

export function buildDevinAcpSpawnInput(
  settings: DevinAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  const globalArgs = buildDevinGlobalArgs(settings);
  const acpArgs = [
    ...(settings?.agentType ? ["--agent-type", settings.agentType] : []),
    ...tokenizeCliArgs(settings?.acpArgs),
  ];

  return {
    command: settings?.binaryPath || "devin",
    args: [...globalArgs, "acp", ...acpArgs],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeDevinAcpRuntime = (
  input: DevinAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildDevinAcpSpawnInput(input.devinSettings, input.cwd, input.environment),
        clientCapabilities: DEVIN_CLIENT_CAPABILITIES,
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

interface DevinAcpModelSelectionRuntime {
  readonly getConfigOptions: AcpSessionRuntime.AcpSessionRuntime["Service"]["getConfigOptions"];
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
  readonly setModel: (model: string) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

export function applyDevinAcpModelSelection<E>(input: {
  readonly runtime: DevinAcpModelSelectionRuntime;
  readonly model: string | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (context: DevinAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    const model = input.model?.trim();
    if (model) {
      yield* input.runtime
        .setModel(model)
        .pipe(Effect.mapError((cause) => input.mapError({ cause })));
    }

    const availableOptions = yield* input.runtime.getConfigOptions;
    const availableIds = new Set(availableOptions.map((option) => option.id));
    for (const selection of input.selections ?? []) {
      if (selection.id === "model" || selection.id === "mode" || !availableIds.has(selection.id)) {
        continue;
      }
      yield* input.runtime
        .setConfigOption(selection.id, selection.value)
        .pipe(Effect.mapError((cause) => input.mapError({ cause, configId: selection.id })));
    }
  });
}
