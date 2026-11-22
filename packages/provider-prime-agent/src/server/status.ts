import {
  type ModelCapabilities,
  ProviderDriverKind,
  type ProviderOptionDescriptor,
  type ServerProviderAuth,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import {
  AUTH_PROBE_TIMEOUT_MS,
  buildSelectOptionDescriptor,
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseCliVersionResult,
  type ProviderProbeResult,
  providerModelsFromSettings,
  providerProbeEnvironment,
  resolveProviderProbeTimeoutMs,
  type ServerProviderDraft,
  spawnAndCollect,
} from "@t3tools/provider-core/server/snapshotProbe";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";

import {
  PRIME_AGENT_RLM_DEPTHS,
  PRIME_AGENT_THINKING_LEVELS,
  type PrimeAgentSettings,
} from "../settings.ts";
import {
  PRIME_AGENT_DEFAULT_MODEL_SLUG,
  PRIME_AGENT_INSTALL_COMMAND,
  PRIME_AGENT_PROVIDER_OPTION_ID,
  PRIME_AGENT_RLM_DEPTH_OPTION_ID,
  PRIME_AGENT_SUPPORTED_RUNTIME_MODES,
  PRIME_AGENT_THINKING_OPTION_ID,
} from "./acpSupport.ts";

const PRIME_AGENT_DRIVER_KIND = ProviderDriverKind.make("primeAgent");
const PRIME_AGENT_PRESENTATION = {
  displayName: "Prime Agent",
  showInteractionModeToggle: false,
  supportedRuntimeModes: PRIME_AGENT_SUPPORTED_RUNTIME_MODES,
} as const;
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

const PRIME_API_KEY_ENV = "PRIME_API_KEY";
const FALLBACK_API_KEY_ENVS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "DEEPSEEK_API_KEY",
] as const;

const THINKING_LABELS: Readonly<Record<string, string>> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

const PROVIDER_CHOICES = [
  { value: "default", label: "CLI default" },
  { value: "prime-inference", label: "Prime Inference" },
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "google", label: "Google Gemini" },
  { value: "openrouter", label: "OpenRouter" },
] as const;

const RLM_DEPTH_LABELS: Readonly<Record<string, string>> = {
  "0": "0 (Off)",
  "1": "1",
  "2": "2 (Default)",
  "3": "3",
  "4": "4",
};

const PRIME_AGENT_SLASH_COMMANDS: ReadonlyArray<ServerProviderSlashCommand> = [
  {
    name: "goal",
    description: "Set, track, pause, or clear a multi-turn objective",
  },
  {
    name: "autonomous",
    description: "Run bounded autonomous loop with turn and token budgets",
  },
  {
    name: "refine",
    description: "Review trajectory and refine supplemental harness state",
  },
  COMPACT_SLASH_COMMAND,
];

const PRIME_AGENT_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: PRIME_AGENT_DEFAULT_MODEL_SLUG,
    name: "Prime Agent default",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "gpt-5",
    name: "GPT-5",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "deepseek-r1",
    name: "DeepSeek R1",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

function primeAgentOptionDescriptors(
  settings: PrimeAgentSettings,
): ReadonlyArray<ProviderOptionDescriptor> {
  const defaultThinking = settings.defaultThinking || "medium";
  const defaultProvider = settings.defaultProvider.trim() || "default";
  const defaultDepth = settings.rlmMaxDepth || "2";

  const thinkingDescriptor: ProviderOptionDescriptor = {
    ...buildSelectOptionDescriptor({
      id: PRIME_AGENT_THINKING_OPTION_ID,
      label: "Thinking",
      options: PRIME_AGENT_THINKING_LEVELS.map((level) => ({
        value: level,
        label: THINKING_LABELS[level] ?? level,
        isDefault: level === defaultThinking,
      })),
    }),
    role: "reasoning",
  };

  const providerDescriptor: ProviderOptionDescriptor = buildSelectOptionDescriptor({
    id: PRIME_AGENT_PROVIDER_OPTION_ID,
    label: "Provider",
    options: PROVIDER_CHOICES.map((choice) => ({
      value: choice.value,
      label: choice.label,
      isDefault: choice.value === defaultProvider,
    })),
  });

  const depthDescriptor: ProviderOptionDescriptor = buildSelectOptionDescriptor({
    id: PRIME_AGENT_RLM_DEPTH_OPTION_ID,
    label: "RLM depth",
    description: "Controls RLM_MAX_DEPTH for recursive rlm.spawn calls.",
    options: PRIME_AGENT_RLM_DEPTHS.map((depth) => ({
      value: depth,
      label: RLM_DEPTH_LABELS[depth] ?? depth,
      isDefault: depth === defaultDepth,
    })),
  });

  return [thinkingDescriptor, providerDescriptor, depthDescriptor];
}

function primeAgentModels(
  settings: PrimeAgentSettings,
  listed: ReadonlyArray<ServerProviderModel> = PRIME_AGENT_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  const optionDescriptors = primeAgentOptionDescriptors(settings);
  const capabilities = createModelCapabilities({ optionDescriptors });
  return providerModelsFromSettings(listed, settings.customModels, capabilities).map((model) => ({
    ...model,
    capabilities,
  }));
}

const snapshot = (
  settings: PrimeAgentSettings,
  checkedAt: string,
  probe: ProviderProbeResult,
  listed?: ReadonlyArray<ServerProviderModel>,
) =>
  buildServerProvider({
    driver: PRIME_AGENT_DRIVER_KIND,
    presentation: PRIME_AGENT_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: primeAgentModels(settings, listed),
    slashCommands: PRIME_AGENT_SLASH_COMMANDS,
    probe,
  });

export const buildInitialPrimeAgentProviderSnapshot = Effect.fn(
  "PrimeAgentProvider.buildInitialPrimeAgentProviderSnapshot",
)(function* (settings: PrimeAgentSettings): Effect.fn.Return<ServerProviderDraft> {
  const now = yield* DateTime.now;
  return snapshot(settings, DateTime.formatIso(now), {
    installed: settings.enabled,
    version: null,
    status: "warning",
    auth: { status: "unknown" },
    message: settings.enabled
      ? "Checking Prime Agent CLI availability..."
      : "Prime Agent is disabled in KBCode settings.",
  });
});

const runPrimeAgentCli = Effect.fn("PrimeAgentProvider.runPrimeAgentCli")(function* (
  settings: PrimeAgentSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) {
  const command = settings.binaryPath || "prime-agent";
  const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
    }),
  );
});

const PrimeAgentStatusJson = Schema.fromJsonString(
  Schema.Struct({
    authenticated: Schema.optional(Schema.Boolean),
    loggedIn: Schema.optional(Schema.Boolean),
    provider: Schema.optional(Schema.NullOr(Schema.String)),
    account: Schema.optional(Schema.NullOr(Schema.String)),
    email: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);
const decodePrimeAgentStatusJson = Schema.decodeUnknownOption(PrimeAgentStatusJson);

/**
 * Interprets `prime-agent status` output (JSON or plain text) plus configured
 * environment API keys without opening an ACP session.
 */
export function primeAgentAuthFromStatus(
  output: { readonly code: number; readonly stdout: string; readonly stderr?: string } | undefined,
  environment: NodeJS.ProcessEnv,
): ServerProviderAuth {
  if (environment[PRIME_API_KEY_ENV]?.trim()) {
    return { status: "authenticated", type: "api_key", label: "Prime API key" };
  }
  const fallbackKey = FALLBACK_API_KEY_ENVS.some((name) => Boolean(environment[name]?.trim()));
  const unauthenticated = (): ServerProviderAuth =>
    fallbackKey
      ? { status: "authenticated", type: "api_key", label: "Provider API key" }
      : { status: "unauthenticated" };
  if (output !== undefined) {
    const trimmed = output.stdout.trim();
    const json = Option.getOrUndefined(decodePrimeAgentStatusJson(trimmed));
    if (json !== undefined) {
      if (json.authenticated === false || json.loggedIn === false) {
        return unauthenticated();
      }
      if (json.authenticated === true || json.loggedIn === true) {
        return {
          status: "authenticated",
          label: json.provider ? `Prime Agent (${json.provider})` : "Prime Agent",
          ...(json.email ? { email: json.email } : {}),
        };
      }
    }
    const combined = `${output.stdout}\n${output.stderr ?? ""}`.toLowerCase();
    if (
      combined.includes("not logged in") ||
      combined.includes("not authenticated") ||
      combined.includes("unauthenticated") ||
      combined.includes("no credentials")
    ) {
      return unauthenticated();
    }
    if (
      output.code === 0 &&
      (combined.includes("authenticated") ||
        combined.includes("logged in") ||
        combined.includes("provider:") ||
        combined.includes("active provider"))
    ) {
      return { status: "authenticated", label: "Prime Agent" };
    }
  }
  if (fallbackKey) {
    return { status: "authenticated", type: "api_key", label: "Provider API key" };
  }
  return { status: "unknown" };
}

const PrimeAgentModelListJson = Schema.fromJsonString(
  Schema.Struct({
    models: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.optional(Schema.String),
        provider: Schema.optional(Schema.String),
      }),
    ),
  }),
);
const decodePrimeAgentModelListJson = Schema.decodeUnknownOption(PrimeAgentModelListJson);

export function primeAgentModelsFromList(
  output: { readonly code: number; readonly stdout: string } | undefined,
): ReadonlyArray<ServerProviderModel> | undefined {
  if (output === undefined || output.code !== 0) return undefined;
  const decoded = Option.getOrUndefined(decodePrimeAgentModelListJson(output.stdout.trim()));
  if (decoded === undefined || decoded.models.length === 0) return undefined;
  const listed: Array<ServerProviderModel> = [
    {
      slug: PRIME_AGENT_DEFAULT_MODEL_SLUG,
      name: "Prime Agent default",
      isCustom: false,
      isDefault: true,
      capabilities: EMPTY_CAPABILITIES,
    },
    ...decoded.models.map((model) => ({
      slug: model.provider ? `${model.provider}/${model.id}` : model.id,
      name: model.name ?? model.id,
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    })),
  ];
  return listed;
}

export const checkPrimeAgentProviderStatus = Effect.fn("checkPrimeAgentProviderStatus")(function* (
  settings: PrimeAgentSettings,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) {
    return snapshot(settings, checkedAt, {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Prime Agent is disabled in KBCode settings.",
    });
  }

  const probeEnvironment = providerProbeEnvironment(environment);
  const versionResult = yield* runPrimeAgentCli(settings, ["--version"], probeEnvironment).pipe(
    Effect.timeoutOption(
      resolveProviderProbeTimeoutMs("primeAgent", VERSION_PROBE_TIMEOUT_MS, environment),
    ),
    Effect.result,
  );
  if (Result.isFailure(versionResult) || Option.isNone(versionResult.success)) {
    const missing = Result.isFailure(versionResult) && isCommandMissingCause(versionResult.failure);
    return snapshot(settings, checkedAt, {
      installed: !missing,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: missing
        ? `Prime Agent CLI (\`prime-agent\`) is not installed or not on PATH. Install with: ${PRIME_AGENT_INSTALL_COMMAND}`
        : "Failed to run `prime-agent --version`.",
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseCliVersionResult(versionOutput);
  if (versionOutput.code !== 0) {
    return snapshot(settings, checkedAt, {
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "Prime Agent CLI is installed but failed to run.",
    });
  }

  const statusResult = yield* runPrimeAgentCli(settings, ["status"], probeEnvironment).pipe(
    Effect.timeoutOption(
      resolveProviderProbeTimeoutMs("primeAgent", AUTH_PROBE_TIMEOUT_MS, environment),
    ),
    Effect.result,
  );
  const auth = primeAgentAuthFromStatus(
    Result.isSuccess(statusResult) ? Option.getOrUndefined(statusResult.success) : undefined,
    environment,
  );
  if (auth.status === "unauthenticated") {
    return snapshot(settings, checkedAt, {
      installed: true,
      version,
      status: "error",
      auth,
      message:
        "Prime Agent CLI is installed but not signed in. Set PRIME_API_KEY or run `prime-agent` and `/login`.",
    });
  }

  return snapshot(settings, checkedAt, {
    installed: true,
    version,
    status: auth.status === "authenticated" ? "ready" : "warning",
    auth,
    ...(auth.status === "authenticated"
      ? {}
      : {
          message:
            "Could not confirm Prime Agent sign-in. Run `prime-agent status` or set PRIME_API_KEY.",
        }),
  });
});
