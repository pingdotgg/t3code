import {
  type KimiSettings,
  type ProviderOptionSelection,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { getProviderOptionStringSelectionValue, normalizeModelSlug } from "@t3tools/shared/model";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { collectSessionConfigOptionValues, findSessionConfigOption } from "./AcpRuntimeModel.ts";

const KIMI_DRIVER_KIND = ProviderDriverKind.make("kimi");
/** Auth method advertised by `kimi acp` (see Moonshot Kimi Code CLI ACP docs). */
const KIMI_AUTH_METHOD_LOGIN = "login";
/**
 * Available to all Kimi Code members; used when the UI has no selection yet.
 * Must be the full ACP model id (provider prefix + alias).
 */
const DEFAULT_KIMI_MODEL = "kimi-code/kimi-for-coding";
const KIMI_MODEL_PROVIDER_PREFIX = "kimi-code/";

/** Short catalog aliases → full ACP model ids advertised by `kimi acp`. */
const KIMI_MODEL_ALIASES: Readonly<Record<string, string>> = {
  k3: "kimi-code/k3",
  "k3-256k": "kimi-code/k3-256k",
  "kimi-for-coding": "kimi-code/kimi-for-coding",
  "kimi-for-coding-highspeed": "kimi-code/kimi-for-coding-highspeed",
  // legacy fallback slug used before the Kimi Code model catalog was wired
  "kimi-k2.5": "kimi-code/kimi-for-coding",
};

type KimiAcpRuntimeKimiSettings = Pick<KimiSettings, "binaryPath">;

interface KimiAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly kimiSettings: KimiAcpRuntimeKimiSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface KimiAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly step: "set-config-option" | "set-model";
  readonly configId?: string;
}

export function buildKimiAcpSpawnInput(
  kimiSettings: KimiAcpRuntimeKimiSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: kimiSettings?.binaryPath || "kimi",
    args: ["acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

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

export function resolveKimiAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const raw = trimmed && trimmed.length > 0 ? trimmed : DEFAULT_KIMI_MODEL;
  const aliased = KIMI_MODEL_ALIASES[raw] ?? raw;
  const withPrefix =
    aliased.includes("/") || aliased.startsWith(KIMI_MODEL_PROVIDER_PREFIX)
      ? aliased
      : `${KIMI_MODEL_PROVIDER_PREFIX}${aliased}`;
  return normalizeModelSlug(withPrefix, KIMI_DRIVER_KIND) ?? DEFAULT_KIMI_MODEL;
}

export function currentKimiModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  const fromModels = sessionSetupResult.models?.currentModelId?.trim();
  if (fromModels) {
    return resolveKimiAcpBaseModelId(fromModels);
  }
  // Kimi advertises the live model on the `model` config option, not SessionModelState.
  const modelOption = findSessionConfigOption(sessionSetupResult.configOptions ?? [], "model");
  if (modelOption?.type === "select" && typeof modelOption.currentValue === "string") {
    const value = modelOption.currentValue.trim();
    return value ? resolveKimiAcpBaseModelId(value) : undefined;
  }
  return undefined;
}

function resolveKimiConfigUpdates(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ReadonlyArray<{ configId: string; value: string }> {
  const updates: Array<{ configId: string; value: string }> = [];

  const thinkingOption = configOptions.find(
    (option) =>
      option.id === "thinking" ||
      option.category === "thought_level" ||
      option.name?.trim().toLowerCase() === "thinking",
  );
  const requestedThinking =
    getProviderOptionStringSelectionValue(selections, "reasoning") ??
    getProviderOptionStringSelectionValue(selections, "thinking");
  if (thinkingOption && requestedThinking) {
    const allowed = collectSessionConfigOptionValues(thinkingOption);
    if (allowed.includes(requestedThinking)) {
      updates.push({ configId: thinkingOption.id, value: requestedThinking });
    }
  }

  const modeOption = configOptions.find(
    (option) => option.id === "mode" || option.category === "mode",
  );
  const requestedMode = getProviderOptionStringSelectionValue(selections, "mode");
  if (modeOption && requestedMode) {
    const allowed = collectSessionConfigOptionValues(modeOption);
    if (allowed.includes(requestedMode)) {
      updates.push({ configId: modeOption.id, value: requestedMode });
    }
  }

  return updates;
}

/**
 * Apply model + optional thinking/mode selections to a live Kimi ACP session.
 *
 * When `selections` is omitted, only `session/set_model` is considered (text
 * generation / simple probes). Full turn starts pass selections so Thinking
 * effort is wired through `session/set_config_option`.
 */
export function applyKimiAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel"> &
    Partial<
      Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "getConfigOptions" | "setConfigOption">
    >;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly selections?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  return Effect.gen(function* () {
    const requested = input.requestedModelId
      ? resolveKimiAcpBaseModelId(input.requestedModelId)
      : undefined;
    const current = input.currentModelId
      ? resolveKimiAcpBaseModelId(input.currentModelId)
      : undefined;
    const shouldSwitchModel = requested !== undefined && requested !== current;

    if (shouldSwitchModel) {
      yield* input.runtime.setSessionModel(requested).pipe(Effect.mapError(input.mapError));
    }

    if (
      input.selections &&
      input.selections.length > 0 &&
      input.runtime.getConfigOptions &&
      input.runtime.setConfigOption
    ) {
      const options = yield* input.runtime.getConfigOptions;
      for (const update of resolveKimiConfigUpdates(options, input.selections)) {
        yield* input.runtime
          .setConfigOption(update.configId, update.value)
          .pipe(Effect.mapError(input.mapError));
      }
    }

    return shouldSwitchModel ? requested : current;
  });
}
