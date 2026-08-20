import {
  type KimiSettings,
  type ProviderInteractionMode,
  ProviderDriverKind,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpClient from "effect-acp/client";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { normalizeModelSlug } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { expandHomePath } from "../../pathExpansion.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const KIMI_CODE_HOME_ENV = "KIMI_CODE_HOME";
// kimi-cli advertises a single terminal-auth method: `login`. The ACP
// `authenticate` call only validates the stored OAuth token; the actual
// device flow happens through `kimi login` (or T3's in-app sign-in, which
// writes the same credentials file).
const KIMI_AUTH_METHOD_LOGIN = "login";
const KIMI_DRIVER_KIND = ProviderDriverKind.make("kimi");

type KimiAcpRuntimeKimiSettings = Pick<KimiSettings, "binaryPath" | "homePath">;

interface KimiAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly kimiSettings: KimiAcpRuntimeKimiSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function resolveKimiHomePath(
  kimiSettings: Pick<KimiSettings, "homePath"> | null | undefined,
): string | undefined {
  const homePath = kimiSettings?.homePath?.trim();
  return homePath ? expandHomePath(homePath) : undefined;
}

export function buildKimiAcpSpawnInput(
  kimiSettings: KimiAcpRuntimeKimiSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  const homePath = resolveKimiHomePath(kimiSettings);
  return {
    command: kimiSettings?.binaryPath || "kimi",
    args: ["acp"],
    cwd,
    ...(environment || homePath
      ? {
          env: {
            ...environment,
            ...(homePath ? { [KIMI_CODE_HOME_ENV]: homePath } : {}),
          },
        }
      : {}),
  };
}

export const probeKimiAcpAuthentication = Effect.fn("probeKimiAcpAuthentication")(function* (
  input: KimiAcpRuntimeInput,
) {
  const spawnInput = buildKimiAcpSpawnInput(input.kimiSettings, input.cwd, input.environment);
  const spawnCommand = yield* resolveSpawnCommand(
    spawnInput.command,
    spawnInput.args,
    spawnInput.env ? { env: spawnInput.env, extendEnv: true } : {},
  );
  const child = yield* input.childProcessSpawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(spawnInput.cwd ? { cwd: spawnInput.cwd } : {}),
        ...(spawnInput.env ? { env: spawnInput.env, extendEnv: true } : {}),
        shell: spawnCommand.shell,
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new EffectAcpErrors.AcpSpawnError({
            command: spawnInput.command,
            cause,
          }),
      ),
    );
  const acpContext = yield* Layer.build(EffectAcpClient.layerChildProcess(child));
  const acp = yield* Effect.service(EffectAcpClient.AcpClient).pipe(Effect.provide(acpContext));
  yield* acp.agent.initialize({
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: input.clientInfo,
  });
  yield* acp.agent.authenticate({ methodId: KIMI_AUTH_METHOD_LOGIN });
});

export const makeKimiAcpRuntime = (
  input: KimiAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildKimiAcpSpawnInput(input.kimiSettings, input.cwd, input.environment),
        authMethodId: KIMI_AUTH_METHOD_LOGIN,
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

// kimi-code aliases its managed models as `kimi-code/<id>` in config.toml,
// and its model-selection RPCs expect those alias ids.
const KIMI_CODE_MODEL_NAMESPACE = "kimi-code/";

type KimiSessionSetupResponse =
  | EffectAcpSchema.LoadSessionResponse
  | EffectAcpSchema.NewSessionResponse
  | EffectAcpSchema.ResumeSessionResponse;

type KimiSelectConfigOption = Extract<
  EffectAcpSchema.SessionConfigOption,
  { readonly type: "select" }
>;

export function findKimiModelConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): KimiSelectConfigOption | undefined {
  if (!configOptions) {
    return undefined;
  }
  const selectOptions = configOptions.filter(
    (option): option is KimiSelectConfigOption => option.type === "select",
  );
  return (
    selectOptions.find((option) => option.category === "model") ??
    selectOptions.find((option) => option.id.trim() === "model")
  );
}

export function kimiModelStateFromSessionSetup(
  sessionSetupResult: KimiSessionSetupResponse,
): EffectAcpSchema.SessionModelState | undefined {
  const modelConfig = findKimiModelConfigOption(sessionSetupResult.configOptions);
  if (modelConfig) {
    const currentModelId = modelConfig.currentValue.trim();
    const seen = new Set<string>();
    const availableModels = modelConfig.options
      .flatMap((entry) => ("value" in entry ? [entry] : entry.options))
      .flatMap((option) => {
        const modelId = option.value.trim();
        if (!modelId || seen.has(modelId)) {
          return [];
        }
        seen.add(modelId);
        const name = option.name.trim() || modelId;
        const description = option.description?.trim() || undefined;
        return [
          {
            modelId,
            name,
            ...(description ? { description } : {}),
          } satisfies EffectAcpSchema.ModelInfo,
        ];
      });
    if (currentModelId && availableModels.length > 0) {
      return { currentModelId, availableModels };
    }
  }
  return sessionSetupResult.models ?? undefined;
}

export function kimiSessionHasModelConfigOption(
  sessionSetupResult: KimiSessionSetupResponse,
): boolean {
  return findKimiModelConfigOption(sessionSetupResult.configOptions) !== undefined;
}

export type KimiAcpModeId = "default" | "plan" | "auto" | "yolo";

export function resolveKimiAcpModeId(input: {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode | undefined;
}): KimiAcpModeId {
  if (input.interactionMode === "plan") {
    return "plan";
  }
  switch (input.runtimeMode) {
    case "approval-required":
      return "default";
    case "auto-accept-edits":
    case "auto":
      return "auto";
    case "full-access":
      return "yolo";
  }
}

export function currentKimiModeIdFromSessionSetup(
  sessionSetupResult: KimiSessionSetupResponse,
): string | undefined {
  const configOptions = sessionSetupResult.configOptions ?? [];
  const modeConfig =
    configOptions.find(
      (option): option is KimiSelectConfigOption =>
        option.type === "select" && option.category === "mode",
    ) ??
    configOptions.find(
      (option): option is KimiSelectConfigOption =>
        option.type === "select" && option.id.trim() === "mode",
    );
  return (
    modeConfig?.currentValue.trim() || sessionSetupResult.modes?.currentModeId.trim() || undefined
  );
}

export function applyKimiAcpModeSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setMode">;
  readonly currentModeId: string | undefined;
  readonly requestedModeId: KimiAcpModeId;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<KimiAcpModeId, E> {
  if (input.currentModeId === input.requestedModeId) {
    return Effect.succeed(input.requestedModeId);
  }
  return input.runtime
    .setMode(input.requestedModeId)
    .pipe(Effect.mapError(input.mapError), Effect.as(input.requestedModeId));
}

export function shouldKimiAdapterAutoApprove(input: {
  readonly runtimeMode: RuntimeMode;
  readonly currentModeId: string | undefined;
}): boolean {
  return input.runtimeMode === "full-access" && input.currentModeId === "yolo";
}

/**
 * Kimi model ids may carry a `kimi-code/` namespace prefix and a `,thinking`
 * variant suffix (e.g. `kimi-code/k3,thinking`). Selection and display always
 * use the base id; the thinking level is a separate session config option in
 * current kimi-cli builds.
 */
export function resolveKimiAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const withoutVariant = trimmed?.split(",", 1)[0]?.trim();
  const withoutNamespace = withoutVariant?.startsWith(KIMI_CODE_MODEL_NAMESPACE)
    ? withoutVariant.slice(KIMI_CODE_MODEL_NAMESPACE.length)
    : withoutVariant;
  const base = withoutNamespace && withoutNamespace.length > 0 ? withoutNamespace : "k3";
  return normalizeModelSlug(base, KIMI_DRIVER_KIND) ?? "k3";
}

/**
 * The ACP wire id for a base model id, resolved against the ids the agent
 * advertised at session setup when it did.
 *
 * kimi-cli (PyPI) advertises `availableModels` with bare ids (`k3`,
 * `k3,thinking`) and expects those on `session/set_model`. Kimi Code CLI
 * (~0.37) advertises namespaced config.toml alias ids through its model config
 * option. Matching an advertised id wins; with nothing advertised, bare ids
 * get the `kimi-code/` namespace; ids that already carry a namespace (custom
 * models such as `moonshot-ai/kimi-k3`) always pass through as-is.
 */
export function resolveKimiAcpWireModelId(
  baseModelId: string,
  advertisedModelIds?: ReadonlyArray<string> | undefined,
): string {
  if (advertisedModelIds && advertisedModelIds.length > 0) {
    const matches = advertisedModelIds.filter(
      (advertised) => resolveKimiAcpBaseModelId(advertised) === baseModelId,
    );
    // Prefer the plain id over its `,thinking` variant when both are advertised.
    const match = matches.find((advertised) => !advertised.includes(",")) ?? matches[0];
    if (match !== undefined) {
      return match;
    }
    // A custom model the agent did not advertise: trust the configured id.
    return baseModelId;
  }
  return baseModelId.includes("/") ? baseModelId : `${KIMI_CODE_MODEL_NAMESPACE}${baseModelId}`;
}

export function advertisedKimiModelIdsFromSessionSetup(
  sessionSetupResult: KimiSessionSetupResponse,
): ReadonlyArray<string> | undefined {
  const models = kimiModelStateFromSessionSetup(sessionSetupResult)?.availableModels;
  return models && models.length > 0 ? models.map((model) => model.modelId) : undefined;
}

export function currentKimiModelIdFromSessionSetup(
  sessionSetupResult: KimiSessionSetupResponse,
): string | undefined {
  return kimiModelStateFromSessionSetup(sessionSetupResult)?.currentModelId?.trim() || undefined;
}

const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

export function applyKimiAcpModelSelection<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "setModel" | "setSessionModel"
  >;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly advertisedModelIds?: ReadonlyArray<string> | undefined;
  readonly hasModelConfigOption: boolean;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const currentBaseModelId = input.currentModelId
    ? resolveKimiAcpBaseModelId(input.currentModelId)
    : undefined;
  const shouldSwitchModel =
    input.requestedModelId !== undefined && input.requestedModelId !== currentBaseModelId;
  if (!shouldSwitchModel) {
    return Effect.succeed(input.currentModelId);
  }
  const wireModelId = resolveKimiAcpWireModelId(input.requestedModelId, input.advertisedModelIds);
  const applyFallbackModel = input.runtime.setSessionModel(wireModelId).pipe(Effect.asVoid);
  const applyModel = input.hasModelConfigOption
    ? input.runtime.setModel(wireModelId).pipe(
        Effect.catchIf(
          (cause) => isAcpRequestError(cause) && cause.code === -32601,
          () => applyFallbackModel,
        ),
      )
    : applyFallbackModel;
  return applyModel.pipe(Effect.mapError(input.mapError), Effect.as(input.requestedModelId));
}

/** True when an ACP failure means "signed out", i.e. `authenticate` was rejected. */
export function isKimiAuthRequiredError(error: unknown): boolean {
  return isAcpRequestError(error) && (error.code === -32000 || error.method === "authenticate");
}
