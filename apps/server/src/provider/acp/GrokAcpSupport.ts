import {
  type GrokSettings,
  type ProviderOptionSelection,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { getProviderOptionStringSelectionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { normalizeModelSlug } from "@t3tools/shared/model";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { makeXAiPromptCompletionRuntime } from "./XAiAcpExtension.ts";

const GROK_API_KEY_ENV = "XAI_API_KEY";
const GROK_OAUTH2_REFERRER_ENV = "GROK_OAUTH2_REFERRER";
const T3_CODE_OAUTH_REFERRER = "t3code";
const GROK_AUTH_METHOD_API_KEY = "xai.api_key";
const GROK_AUTH_METHOD_CACHED_TOKEN = "cached_token";
const GROK_DRIVER_KIND = ProviderDriverKind.make("grok");

type GrokAcpRuntimeGrokSettings = Pick<GrokSettings, "binaryPath">;

/** Process-level agent options. Live Grok exposes effort via CLI flags, not ACP config options. */
export interface GrokAcpSpawnOptions {
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly alwaysApprove?: boolean;
}

interface GrokAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly grokSettings: GrokAcpRuntimeGrokSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly spawnOptions?: GrokAcpSpawnOptions;
}

export function buildGrokAcpSpawnInput(
  grokSettings: GrokAcpRuntimeGrokSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  spawnOptions?: GrokAcpSpawnOptions,
): AcpSessionRuntime.AcpSpawnInput {
  const args: string[] = ["agent"];
  const model = spawnOptions?.model?.trim();
  if (model) {
    args.push("--model", model);
  }
  const effort = spawnOptions?.reasoningEffort?.trim();
  if (effort) {
    args.push("--reasoning-effort", effort);
  }
  if (spawnOptions?.alwaysApprove) {
    args.push("--always-approve");
  }
  args.push("stdio");
  return {
    command: grokSettings?.binaryPath || "grok",
    args,
    cwd,
    env: {
      ...environment,
      [GROK_OAUTH2_REFERRER_ENV]: T3_CODE_OAUTH_REFERRER,
    },
  };
}

export function resolveGrokReasoningEffortSelection(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): string | undefined {
  return (
    getProviderOptionStringSelectionValue(selections, "reasoningEffort") ??
    getProviderOptionStringSelectionValue(selections, "reasoning") ??
    getProviderOptionStringSelectionValue(selections, "effort")
  );
}



/**
 * Grok has no ACP session modes on live 0.2.x. Plan mode is entered via the
 * `/plan` slash command (see Grok Build user guide). Map T3 interactionMode
 * onto that command so Plan/Build in the composer does real work.
 */
export function applyGrokPlanModeToPromptText(input: {
  readonly text: string | undefined;
  readonly interactionMode: "plan" | "default" | undefined;
}): string | undefined {
  const trimmed = input.text?.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (input.interactionMode === "plan") {
    if (/^\/plan(?:\s|$)/i.test(trimmed)) {
      return trimmed;
    }
    return `/plan ${trimmed}`;
  }
  return trimmed;
}

function resolveGrokAuthMethodId(environment: NodeJS.ProcessEnv | undefined): string {
  return environment?.[GROK_API_KEY_ENV]?.trim()
    ? GROK_AUTH_METHOD_API_KEY
    : GROK_AUTH_METHOD_CACHED_TOKEN;
}

export const makeGrokAcpRuntime = (
  input: GrokAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildGrokAcpSpawnInput(
          input.grokSettings,
          input.cwd,
          input.environment,
          input.spawnOptions,
        ),
        authMethodId: resolveGrokAuthMethodId(input.environment),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
    return yield* makeXAiPromptCompletionRuntime(runtime);
  });

export function resolveGrokAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : "grok-build";
  return normalizeModelSlug(base, GROK_DRIVER_KIND) ?? "grok-build";
}

export function currentGrokModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export function applyGrokAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const shouldSwitchModel =
    input.requestedModelId !== undefined && input.requestedModelId !== input.currentModelId;
  if (!shouldSwitchModel) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime
    .setSessionModel(input.requestedModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(input.requestedModelId));
}

function isEffortConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  const category = option.category?.trim().toLowerCase() ?? "";
  return (
    id === "reasoning" ||
    id === "reasoningeffort" ||
    id === "reasoning_effort" ||
    id === "effort" ||
    name.includes("reasoning") ||
    name.includes("effort") ||
    category === "thought_level"
  );
}

/**
 * Secondary path: only when Grok advertises effort as ACP config options.
 * Live Grok 0.2.x has no session/set_config_option; effort is CLI
 * `--reasoning-effort` via buildGrokAcpSpawnInput / process restart.
 */
export function applyGrokAcpConfigSelections<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "getConfigOptions" | "setConfigOption"
  >;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    if (!input.selections || input.selections.length === 0) {
      return;
    }
    const configOptions = yield* input.runtime.getConfigOptions.pipe(
      Effect.mapError(input.mapError),
    );
    if (!configOptions || configOptions.length === 0) {
      return;
    }
    const requestedEffort =
      getProviderOptionStringSelectionValue(input.selections, "reasoningEffort") ??
      getProviderOptionStringSelectionValue(input.selections, "reasoning") ??
      getProviderOptionStringSelectionValue(input.selections, "effort");
    if (!requestedEffort) {
      return;
    }
    const effortOption = configOptions.find(isEffortConfigOption);
    if (!effortOption || effortOption.type !== "select") {
      return;
    }
    const values = effortOption.options.flatMap((entry) =>
      "value" in entry ? [entry.value] : entry.options.map((option) => option.value),
    );
    const match = values.find(
      (value) => value.trim().toLowerCase() === requestedEffort.trim().toLowerCase(),
    );
    if (!match || match === effortOption.currentValue) {
      return;
    }
    yield* input.runtime
      .setConfigOption(effortOption.id, match)
      .pipe(Effect.mapError(input.mapError));
  });
}
