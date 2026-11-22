import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ModelSelection, ProviderApprovalOption, RuntimeMode } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import type * as EffectAcpSchema from "effect-acp/compat";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  acpPermissionDisposition,
  type AcpPermissionDisposition,
  type AcpRuntimePolicy,
} from "@t3tools/provider-acp/server/clientPolicy";
import type { PrimeAgentSettings } from "../settings.ts";

export const PRIME_AGENT_INSTALL_COMMAND =
  "curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh";

export const PRIME_AGENT_DEFAULT_MODEL_SLUG = "default";
export const PRIME_AGENT_THINKING_OPTION_ID = "thinking";
export const PRIME_AGENT_PROVIDER_OPTION_ID = "primeProvider";
export const PRIME_AGENT_RLM_DEPTH_OPTION_ID = "rlmMaxDepth";
const PRIME_AGENT_AUTONOMOUS_TURNS_OPTION_ID = "autonomousMaxTurns";
const PRIME_AGENT_AUTONOMOUS_TOKENS_OPTION_ID = "autonomousMaxTokens";

export const PRIME_AGENT_OWNED_OPTION_IDS = [
  PRIME_AGENT_THINKING_OPTION_ID,
  PRIME_AGENT_PROVIDER_OPTION_ID,
  PRIME_AGENT_RLM_DEPTH_OPTION_ID,
  PRIME_AGENT_AUTONOMOUS_TURNS_OPTION_ID,
  PRIME_AGENT_AUTONOMOUS_TOKENS_OPTION_ID,
] as const;

export const PRIME_AGENT_SUPPORTED_RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;

const DEFAULT_RLM_MAX_DEPTH = "2";
const POSITIVE_INT_PATTERN = /^\d+$/;

function parsePositiveIntString(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed || !POSITIVE_INT_PATTERN.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? String(parsed) : undefined;
}

function parseNonNegativeIntString(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed || !POSITIVE_INT_PATTERN.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? String(parsed) : undefined;
}

export interface PrimeAgentLaunchConfig {
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly thinking: string | undefined;
  readonly rlmMaxDepth: string;
  readonly autonomousMaxTurns: string | undefined;
  readonly autonomousMaxTokens: string | undefined;
}

/**
 * Resolves CLI flags and RLM_MAX_DEPTH from per-thread modelSelection overrides
 * falling back to instance settings and environment overrides.
 */
function resolvePrimeAgentLaunchConfig(input: {
  readonly settings: PrimeAgentSettings | null | undefined;
  readonly modelSelection?: ModelSelection | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
}): PrimeAgentLaunchConfig {
  const { settings, modelSelection, environment } = input;
  const explicitProvider = getModelSelectionStringOptionValue(
    modelSelection,
    PRIME_AGENT_PROVIDER_OPTION_ID,
  )?.trim();
  let provider =
    explicitProvider && explicitProvider !== "default"
      ? explicitProvider
      : settings?.defaultProvider?.trim() || undefined;

  const rawModel = modelSelection?.model?.trim();
  let model =
    rawModel && rawModel.length > 0 && rawModel !== PRIME_AGENT_DEFAULT_MODEL_SLUG
      ? rawModel
      : undefined;

  // Allow provider/model custom slugs when no explicit --provider was picked.
  if (model && !provider) {
    const slashIndex = model.indexOf("/");
    if (slashIndex > 0 && slashIndex < model.length - 1) {
      provider = model.slice(0, slashIndex).trim();
      model = model.slice(slashIndex + 1).trim();
    }
  }

  const thinking =
    getModelSelectionStringOptionValue(modelSelection, PRIME_AGENT_THINKING_OPTION_ID)?.trim() ||
    settings?.defaultThinking ||
    undefined;

  const rlmMaxDepth =
    parseNonNegativeIntString(
      getModelSelectionStringOptionValue(modelSelection, PRIME_AGENT_RLM_DEPTH_OPTION_ID),
    ) ??
    parseNonNegativeIntString(environment?.RLM_MAX_DEPTH) ??
    parseNonNegativeIntString(settings?.rlmMaxDepth) ??
    DEFAULT_RLM_MAX_DEPTH;

  const autonomousMaxTurns =
    parsePositiveIntString(
      getModelSelectionStringOptionValue(modelSelection, PRIME_AGENT_AUTONOMOUS_TURNS_OPTION_ID),
    ) ?? parsePositiveIntString(settings?.autonomousMaxTurns);

  const autonomousMaxTokens =
    parsePositiveIntString(
      getModelSelectionStringOptionValue(modelSelection, PRIME_AGENT_AUTONOMOUS_TOKENS_OPTION_ID),
    ) ?? parsePositiveIntString(settings?.autonomousMaxTokens);

  return {
    provider,
    model,
    thinking,
    rlmMaxDepth,
    autonomousMaxTurns,
    autonomousMaxTokens,
  };
}

/**
 * Prime Agent binds --provider, --model, --thinking, RLM_MAX_DEPTH, and autonomous
 * budget caps at process startup, so changing any of them requires restarting the
 * child process and reattaching via --resume <session_id>.
 */
export function primeAgentRequiresSessionRestart(
  current: ModelSelection,
  target: ModelSelection,
  settings?: PrimeAgentSettings | null,
  environment?: NodeJS.ProcessEnv,
): boolean {
  const prev = resolvePrimeAgentLaunchConfig({ settings, modelSelection: current, environment });
  const next = resolvePrimeAgentLaunchConfig({ settings, modelSelection: target, environment });
  return (
    prev.provider !== next.provider ||
    prev.model !== next.model ||
    prev.thinking !== next.thinking ||
    prev.rlmMaxDepth !== next.rlmMaxDepth ||
    prev.autonomousMaxTurns !== next.autonomousMaxTurns ||
    prev.autonomousMaxTokens !== next.autonomousMaxTokens
  );
}

export function buildPrimeAgentAcpSpawnInput(input: {
  readonly settings: PrimeAgentSettings | null | undefined;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly modelSelection?: ModelSelection | undefined;
  readonly resumeSessionId?: string | undefined;
}): AcpSessionRuntime.AcpSpawnInput {
  const launch = resolvePrimeAgentLaunchConfig({
    settings: input.settings,
    modelSelection: input.modelSelection,
    environment: input.environment,
  });
  const args: Array<string> = ["--mode", "acp"];
  if (launch.provider) {
    args.push("--provider", launch.provider);
  }
  if (launch.model) {
    args.push("--model", launch.model);
  }
  if (launch.thinking) {
    args.push("--thinking", launch.thinking);
  }
  if (input.resumeSessionId && input.resumeSessionId.trim().length > 0) {
    args.push("--resume", input.resumeSessionId.trim());
  }
  if (launch.autonomousMaxTurns) {
    args.push("--autonomous-max-turns", launch.autonomousMaxTurns);
  }
  if (launch.autonomousMaxTokens) {
    args.push("--autonomous-max-tokens", launch.autonomousMaxTokens);
  }
  return {
    command: input.settings?.binaryPath || "prime-agent",
    args,
    cwd: input.cwd,
    env: {
      ...input.environment,
      RLM_MAX_DEPTH: launch.rlmMaxDepth,
    },
  };
}

export function primeAgentApprovalOptions(
  request: EffectAcpSchema.RequestPermissionRequest,
): ReadonlyArray<ProviderApprovalOption> {
  const has = (kind: EffectAcpSchema.PermissionOption["kind"]) =>
    request.options.some((option) => option.kind === kind && option.optionId.trim().length > 0);
  return [
    ...(has("allow_once")
      ? [{ decision: "accept", label: "Allow once" } as const]
      : has("allow_always")
        ? [{ decision: "acceptForSession", label: "Always allow" } as const]
        : []),
    ...(has("reject_once") ? [{ decision: "decline", label: "Deny" } as const] : []),
    { decision: "cancel", label: "Cancel" },
  ];
}

export function primeAgentPermissionDisposition(
  policy: AcpRuntimePolicy,
  request: EffectAcpSchema.RequestPermissionRequest,
): AcpPermissionDisposition {
  const disposition = acpPermissionDisposition(policy, request);
  const offersOnce = request.options.some(
    (option) => option.kind === "allow_once" && option.optionId.trim().length > 0,
  );
  return disposition === "allow" && !offersOnce ? "ask" : disposition;
}

export interface PrimeAgentAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "resumeMethod" | "spawn"
> {
  readonly settings: PrimeAgentSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly modelSelection?: ModelSelection | undefined;
}

export const makePrimeAgentAcpRuntime = Effect.fn("PrimeAgentAcpSupport.makePrimeAgentAcpRuntime")(
  function* (
    input: PrimeAgentAcpRuntimeInput,
  ): Effect.fn.Return<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom | Scope.Scope
  > {
    const { settings, environment, modelSelection, ...runtimeOptions } = input;
    const processGroupPlatform = yield* HostProcess.Platform.pipe(
      Effect.provide(NodeServices.layer),
    );
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...runtimeOptions,
        resumeMethod: "cli-flag",
        ownDetachedProcessGroup: true,
        ownDescendantProcessGroups: processGroupPlatform === "linux",
        processGroupPlatform,
        spawn: buildPrimeAgentAcpSpawnInput({
          settings,
          cwd: input.cwd,
          environment,
          modelSelection,
          resumeSessionId: input.resumeSessionId,
        }),
      }),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
  },
);
