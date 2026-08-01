import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type GrokSettings,
  type ModelCapabilities,
  type ModelSelection,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  getModelSelectionOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  normalizeModelSlug,
} from "@t3tools/shared/model";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { makeXAiPromptCompletionRuntime } from "./XAiAcpExtension.ts";

const GROK_API_KEY_ENV = "XAI_API_KEY";
const GROK_OAUTH2_REFERRER_ENV = "GROK_OAUTH2_REFERRER";
const T3_CODE_OAUTH_REFERRER = "t3code";
const GROK_AUTH_METHOD_API_KEY = "xai.api_key";
const GROK_AUTH_METHOD_CACHED_TOKEN = "cached_token";
const GROK_DRIVER_KIND = ProviderDriverKind.make("grok");

export const GROK_REASONING_EFFORT_OPTION_ID = "reasoningEffort";
export const GROK_FALLBACK_REASONING_EFFORTS_BY_MODEL: ReadonlyMap<
  string,
  { readonly values: ReadonlyArray<string>; readonly defaultValue: string }
> = new Map([
  [
    "grok-4.5",
    {
      values: ["high", "medium", "low"],
      defaultValue: "high",
    },
  ],
]);

/**
 * Effort levels are advertised per model via ACP `_meta`, so the token guard
 * is syntactic rather than a fixed catalog: a fixed set would silently drop a
 * future menu-advertised level. Shared by discovery parsing and spawn so a
 * menu entry cannot advertise a value the spawn later omits. The agent itself
 * clamps levels outside the model's menu to the model default (verified
 * against grok 0.2.117).
 */
const GROK_REASONING_EFFORT_TOKEN = /^[a-z0-9][a-z0-9._-]{0,31}$/i;

export interface GrokReasoningEffortConstraints {
  readonly defaultValue: string | undefined;
  readonly values: ReadonlyArray<string>;
}

/** CLI-safe effort token for discovery menus and `--reasoning-effort` spawn. */
export function isValidGrokReasoningEffortToken(value: string): boolean {
  return GROK_REASONING_EFFORT_TOKEN.test(value);
}

/** Extract the authoritative effort menu advertised for one Grok model. */
export function grokReasoningEffortConstraintsFromCapabilities(
  capabilities: ModelCapabilities | null | undefined,
): GrokReasoningEffortConstraints | null {
  if (capabilities == null) {
    return null;
  }
  const descriptor = getProviderOptionDescriptors({ caps: capabilities }).find(
    (candidate) => candidate.id === GROK_REASONING_EFFORT_OPTION_ID && candidate.type === "select",
  );
  if (descriptor?.type !== "select") {
    return null;
  }
  const values = descriptor.options
    .map((option) => option.id)
    .filter(isValidGrokReasoningEffortToken);
  if (values.length === 0) {
    return null;
  }
  const currentValue = getProviderOptionCurrentValue(descriptor);
  return {
    values,
    defaultValue:
      typeof currentValue === "string" && values.includes(currentValue) ? currentValue : undefined,
  };
}

/**
 * Grok ACP has no session/set_config_option (configOptions is null as of
 * 0.2.x), so reasoning effort can only be applied via the agent spawn flag.
 * Malformed stored values are dropped. Well-formed stale values normalize to
 * the advertised model default when discovered constraints are available.
 */
export function resolveGrokReasoningEffortForSpawn(
  modelSelection: ModelSelection | null | undefined,
  constraints?: GrokReasoningEffortConstraints | null,
): string | undefined {
  const effort = getModelSelectionStringOptionValue(
    modelSelection,
    GROK_REASONING_EFFORT_OPTION_ID,
  )?.trim();
  if (!effort || !isValidGrokReasoningEffortToken(effort)) {
    return undefined;
  }
  if (constraints === null) {
    return undefined;
  }
  if (constraints === undefined) {
    return effort;
  }
  return constraints.values.includes(effort) ? effort : constraints.defaultValue;
}

/** Semantic spawn value used when comparing and tracking active Grok sessions. */
export function resolveGrokSpawnOptionValue(
  modelSelection: ModelSelection,
  optionId: string,
  constraints?: GrokReasoningEffortConstraints | null,
): string | boolean | undefined {
  if (optionId !== GROK_REASONING_EFFORT_OPTION_ID) {
    return getModelSelectionOptionValue(modelSelection, optionId);
  }
  if (constraints === null) {
    return undefined;
  }
  return (
    resolveGrokReasoningEffortForSpawn(modelSelection, constraints) ??
    constraints?.defaultValue ??
    (constraints === undefined
      ? GROK_FALLBACK_REASONING_EFFORTS_BY_MODEL.get(
          resolveGrokAcpBaseModelId(modelSelection.model),
        )?.defaultValue
      : undefined)
  );
}

type GrokAcpRuntimeGrokSettings = Pick<GrokSettings, "binaryPath">;

interface GrokAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly grokSettings: GrokAcpRuntimeGrokSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly reasoningEffort?: string | undefined;
}

export function buildGrokAcpSpawnInput(
  grokSettings: GrokAcpRuntimeGrokSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  reasoningEffort?: string | undefined,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: grokSettings?.binaryPath || "grok",
    args:
      reasoningEffort === undefined
        ? ["agent", "stdio"]
        : ["agent", "--reasoning-effort", reasoningEffort, "stdio"],
    cwd,
    env: {
      ...environment,
      [GROK_OAUTH2_REFERRER_ENV]: T3_CODE_OAUTH_REFERRER,
    },
  };
}

function resolveGrokAuthMethodId(environment: NodeJS.ProcessEnv | undefined): string {
  return environment?.[GROK_API_KEY_ENV]?.trim()
    ? GROK_AUTH_METHOD_API_KEY
    : GROK_AUTH_METHOD_CACHED_TOKEN;
}

export function grokAcpRuntimeProcessOwnership(
  processGroupPlatform: NodeJS.Platform,
): Pick<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "ownDescendantProcessGroups" | "ownDetachedProcessGroup" | "processGroupPlatform"
> {
  return {
    // macOS keeps the prior provider-group teardown until a stable libproc
    // identity provider can cover Grok's nested detached tool groups.
    ownDescendantProcessGroups: processGroupPlatform === "linux",
    ownDetachedProcessGroup: true,
    processGroupPlatform,
  };
}

export const makeGrokAcpRuntime = (
  input: GrokAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const processGroupPlatform = yield* HostProcessPlatform.pipe(
      Effect.provide(NodeServices.layer),
    );
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildGrokAcpSpawnInput(
          input.grokSettings,
          input.cwd,
          input.environment,
          input.reasoningEffort,
        ),
        authMethodId: resolveGrokAuthMethodId(input.environment),
        // Current Grok treats Ctrl+C cancellation as a barrier against stale
        // background-task wake prompts until the next genuine user turn.
        cancelMeta: { ...input.cancelMeta, cancelTrigger: "ctrl_c" },
        ...grokAcpRuntimeProcessOwnership(processGroupPlatform),
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
