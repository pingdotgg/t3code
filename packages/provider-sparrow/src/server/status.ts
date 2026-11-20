import {
  ProviderDriverKind,
  type ServerProviderAuth,
  type ServerProviderModel,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
  type ServerProviderSubProvider,
} from "@t3tools/contracts";
import type { SparrowSettings } from "../settings.ts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  nonEmptyTrimmed,
  parseCliVersionResult,
  providerModelsFromSettings,
  providerProbeEnvironment,
  resolveProviderProbeTimeoutMs,
  spawnAndCollect,
  type ProviderProbeResult,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  buildSparrowThoughtLevelDescriptor,
  encodeSparrowAcpModelId,
  parseSparrowModelRef,
  resolveSparrowProcessEnvironment,
  SPARROW_DEFAULT_MODEL_SLUG,
  SPARROW_DRIVER_KIND,
  SPARROW_RUNTIME_MODES,
  SPARROW_SUPPORTED_RUNTIME_MODES,
} from "./acpSupport.ts";
import { discoverSparrowSkills, discoverSparrowSlashCommands } from "./skills.ts";

const VERSION_PROBE_TIMEOUT_MS = 10_000;

interface SparrowModelEntry {
  readonly id: string;
  readonly name?: string;
  readonly reasoning?: boolean;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly input?: ReadonlyArray<string>;
  readonly thinkingLevelMap?: Readonly<Record<string, string | null>>;
}

interface SparrowProviderEntry {
  readonly api?: string;
  readonly rigProvider?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly oauthCachePath?: string;
  readonly models: ReadonlyArray<SparrowModelEntry>;
}

const SPARROW_BUILTIN_CODEX_MODELS: ReadonlyArray<SparrowModelEntry> = [
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    reasoning: true,
    thinkingLevelMap: { minimal: null, low: "minimal", xhigh: "xhigh" },
  },
  {
    id: "gpt-5.3-codex-spark",
    name: "GPT-5.3 Codex Spark",
    reasoning: true,
    thinkingLevelMap: { minimal: null, low: "minimal", xhigh: "xhigh" },
  },
  {
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    reasoning: true,
    thinkingLevelMap: { minimal: null, low: "minimal", xhigh: "xhigh", max: "max" },
  },
  {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    reasoning: true,
    thinkingLevelMap: { minimal: null, low: "minimal", xhigh: "xhigh", max: "max" },
  },
  {
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    reasoning: true,
    thinkingLevelMap: { minimal: null, low: "minimal", xhigh: "xhigh", max: "max" },
  },
  {
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, low: "minimal", xhigh: "xhigh", max: "max" },
  },
  {
    id: "gpt-6-luna",
    name: "GPT-6 Luna",
    reasoning: true,
    thinkingLevelMap: { off: "off", minimal: null, low: "minimal", xhigh: "xhigh", max: "max" },
  },
  {
    id: "gpt-6-sol",
    name: "GPT-6 Sol",
    reasoning: true,
    thinkingLevelMap: { off: "off", minimal: null, low: "minimal", xhigh: "xhigh", max: "max" },
  },
];

const SPARROW_PRESENTATION = {
  displayName: "Sparrow",
  showInteractionModeToggle: false,
  reportsContextWindow: true,
  supportedRuntimeModes: SPARROW_SUPPORTED_RUNTIME_MODES,
  runtimeModes: SPARROW_RUNTIME_MODES,
} as const;

const customThinkingDescriptor = buildSparrowThoughtLevelDescriptor({ reasoning: true });
const SPARROW_CUSTOM_MODEL_CAPABILITIES = createModelCapabilities({
  optionDescriptors: customThinkingDescriptor ? [customThinkingDescriptor] : [],
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseJsonSafe(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", ".*").replaceAll("?", ".")}$`);
}

function normalizeEnabledPattern(rawPattern: string): string {
  const trimmed = rawPattern.trim();
  const parsed = parseSparrowModelRef(trimmed);
  if (parsed?.provider) {
    return `${parsed.provider}/${parsed.modelId}`;
  }
  return trimmed.replaceAll("<", "").replaceAll(">", "");
}

export function matchesSparrowEnabledModels(
  enabledModels: ReadonlyArray<string> | undefined,
  provider: string,
  modelId: string,
): boolean {
  if (!enabledModels || enabledModels.length === 0) return true;
  const candidate = `${provider}/${modelId}`;
  return enabledModels.some((rawPattern) => {
    const normalized = normalizeEnabledPattern(rawPattern);
    return normalized.length > 0 && globToRegex(normalized).test(candidate);
  });
}

function resolveSparrowHomeDirectory(
  settings: Pick<SparrowSettings, "homePath">,
  environment: NodeJS.ProcessEnv,
  hostHome: string,
): string {
  const configured = nonEmptyTrimmed(settings.homePath);
  if (configured) return configured;
  return nonEmptyTrimmed(environment.HOME) ?? nonEmptyTrimmed(environment.USERPROFILE) ?? hostHome;
}

function parseProviderEntry(raw: unknown): SparrowProviderEntry | undefined {
  if (!isRecord(raw)) return undefined;
  const rawModels = Array.isArray(raw.models) ? raw.models : [];
  const models: Array<SparrowModelEntry> = [];
  for (const item of rawModels) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === "string" ? nonEmptyTrimmed(item.id) : undefined;
    if (!id) continue;
    const thinkingLevelMap = isRecord(item.thinkingLevelMap)
      ? Object.fromEntries(
          Object.entries(item.thinkingLevelMap).filter(
            (entry): entry is [string, string | null] =>
              entry[1] === null || typeof entry[1] === "string",
          ),
        )
      : undefined;
    models.push({
      id,
      ...(typeof item.name === "string" && item.name.trim() ? { name: item.name.trim() } : {}),
      ...(typeof item.reasoning === "boolean" ? { reasoning: item.reasoning } : {}),
      ...(typeof item.contextWindow === "number" ? { contextWindow: item.contextWindow } : {}),
      ...(typeof item.maxTokens === "number" ? { maxTokens: item.maxTokens } : {}),
      ...(Array.isArray(item.input)
        ? { input: item.input.filter((v): v is string => typeof v === "string") }
        : {}),
      ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    });
  }
  return {
    ...(typeof raw.api === "string" ? { api: raw.api } : {}),
    ...(typeof raw.rigProvider === "string" ? { rigProvider: raw.rigProvider } : {}),
    ...(typeof raw.baseUrl === "string" ? { baseUrl: raw.baseUrl } : {}),
    ...(typeof raw.apiKey === "string" ? { apiKey: raw.apiKey } : {}),
    ...(typeof raw.oauthCachePath === "string" ? { oauthCachePath: raw.oauthCachePath } : {}),
    models,
  };
}

const hasValidChatGptAuth = Effect.fn("SparrowStatus.hasValidChatGptAuth")(function* (
  authPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const content = yield* fileSystem.readFileString(authPath).pipe(Effect.option);
  if (Option.isNone(content)) return false;
  const parsed = parseJsonSafe(content.value);
  if (!isRecord(parsed)) return false;
  return (
    typeof parsed.access_token === "string" &&
    parsed.access_token.length > 0 &&
    typeof parsed.account_id === "string" &&
    parsed.account_id.length > 0
  );
});

const evaluateProviderCredential = Effect.fn("SparrowStatus.evaluateProviderCredential")(
  function* (input: {
    readonly providerName: string;
    readonly provider: SparrowProviderEntry;
    readonly defaultChatGptAuthPath: string;
    readonly sparrowHome: string;
    readonly environment: NodeJS.ProcessEnv;
  }): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem> {
    const { providerName, provider, environment } = input;
    const ref = nonEmptyTrimmed(provider.apiKey);

    if (provider.api === "openai-codex-responses" && !ref) {
      const authPath = provider.oauthCachePath
        ? expandHomePath(provider.oauthCachePath, input.sparrowHome)
        : input.defaultChatGptAuthPath;
      return (yield* hasValidChatGptAuth(authPath))
        ? undefined
        : `ChatGPT login required for ${providerName} models.`;
    }

    if (!ref) return undefined;
    if (ref.startsWith("!")) {
      return `Unsupported command-based apiKey in ${providerName}.`;
    }
    if (ref.startsWith("$")) {
      const envName = ref.startsWith("${") && ref.endsWith("}") ? ref.slice(2, -1) : ref.slice(1);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
        return `Invalid apiKey environment variable reference '${ref}' in ${providerName}.`;
      }
      if (!nonEmptyTrimmed(environment[envName])) {
        return `Set environment variable ${envName} for ${providerName}.`;
      }
    }
    return undefined;
  },
);

function resolveConfiguredDefaultThinkingLevels(raw: unknown): ReadonlyMap<string, string> {
  const resolved = new Map<string, string>();
  if (!isRecord(raw)) return resolved;
  for (const [ref, level] of Object.entries(raw)) {
    if (typeof level !== "string") continue;
    const parsed = parseSparrowModelRef(ref);
    if (parsed?.provider) {
      resolved.set(`${parsed.provider}\0${parsed.modelId}`, level);
    }
  }
  return resolved;
}

function sparrowSnapshot(input: {
  readonly settings: SparrowSettings;
  readonly checkedAt: string;
  readonly probe: ProviderProbeResult;
  readonly models?: ReadonlyArray<ServerProviderModel>;
  readonly subProviders?: ReadonlyArray<ServerProviderSubProvider>;
  readonly slashCommands?: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills?: ReadonlyArray<ServerProviderSkill>;
}): ServerProviderDraft {
  return {
    ...buildServerProvider({
      driver: SPARROW_DRIVER_KIND,
      presentation: SPARROW_PRESENTATION,
      enabled: input.settings.enabled,
      checkedAt: input.checkedAt,
      models: input.models ?? [],
      ...(input.slashCommands ? { slashCommands: input.slashCommands } : {}),
      ...(input.skills ? { skills: input.skills } : {}),
      probe: input.probe,
    }),
    ...(input.subProviders && input.subProviders.length > 0
      ? { subProviders: input.subProviders }
      : {}),
    // `sparrow --acp` saves every started session on disk; disable throwaway text generation.
    supportsTextGeneration: false,
  };
}

export const buildInitialSparrowProviderSnapshot = (
  settings: SparrowSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.map(DateTime.now, (now) =>
    sparrowSnapshot({
      settings,
      checkedAt: DateTime.formatIso(now),
      probe: {
        installed: settings.enabled,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "Checking Sparrow CLI availability..."
          : "Sparrow is disabled in T3 Code settings.",
      },
      models: providerModelsFromSettings(
        [
          {
            slug: SPARROW_DEFAULT_MODEL_SLUG,
            name: "Default",
            isCustom: false,
            isDefault: true,
            capabilities: createModelCapabilities({ optionDescriptors: [] }),
          },
        ],
        settings.customModels,
        SPARROW_CUSTOM_MODEL_CAPABILITIES,
      ),
    }),
  );

const runSparrowCli = Effect.fn("runSparrowCli")(function* (
  settings: SparrowSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) {
  const command = settings.binaryPath || "sparrow";
  const env = resolveSparrowProcessEnvironment(settings, environment) ?? environment;
  const spawnCommand = yield* resolveSpawnCommand(command, args, { env });
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env,
      shell: spawnCommand.shell,
    }),
  );
});

export const checkSparrowProviderStatus = Effect.fn("checkSparrowProviderStatus")(function* (
  settings: SparrowSettings,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) {
    return sparrowSnapshot({
      settings,
      checkedAt,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Sparrow is disabled in T3 Code settings.",
      },
    });
  }

  const probeEnvironment = providerProbeEnvironment(environment);
  const versionResult = yield* runSparrowCli(settings, ["--version"], probeEnvironment).pipe(
    Effect.timeoutOption(
      resolveProviderProbeTimeoutMs(SPARROW_DRIVER_KIND, VERSION_PROBE_TIMEOUT_MS, environment),
    ),
    Effect.result,
  );
  if (Result.isFailure(versionResult) || Option.isNone(versionResult.success)) {
    const missing = Result.isFailure(versionResult) && isCommandMissingCause(versionResult.failure);
    return sparrowSnapshot({
      settings,
      checkedAt,
      probe: {
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: missing
          ? "Sparrow CLI (`sparrow`) is not installed or not on PATH."
          : "Failed to run `sparrow --version`.",
      },
    });
  }
  const versionOutput = versionResult.success.value;
  const version = parseCliVersionResult(versionOutput);
  if (versionOutput.code !== 0) {
    return sparrowSnapshot({
      settings,
      checkedAt,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Sparrow is installed but failed to run `--version`.",
      },
    });
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostHome = yield* HostProcess.HomeDirectory;
  const sparrowHome = resolveSparrowHomeDirectory(settings, environment, hostHome);
  const configDir = path.join(sparrowHome, ".config", "sparrow");
  const modelsPath = path.join(configDir, "models.json");
  const configPath = path.join(configDir, "config.json");
  const chatGptAuthPath = path.join(configDir, "chatgpt-auth.json");

  const [slashCommands, skills] = yield* Effect.all([
    discoverSparrowSlashCommands({ settings, environment }),
    discoverSparrowSkills({ settings, environment }),
  ]);

  const rawModelsText = yield* fileSystem.readFileString(modelsPath).pipe(Effect.option);
  if (Option.isNone(rawModelsText)) {
    return sparrowSnapshot({
      settings,
      checkedAt,
      slashCommands,
      skills,
      models: providerModelsFromSettings(
        [],
        settings.customModels,
        SPARROW_CUSTOM_MODEL_CAPABILITIES,
      ),
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unauthenticated", type: ProviderDriverKind.make("sparrow") },
        message:
          "Sparrow is not configured yet. Run `sparrow` in a terminal or create ~/.config/sparrow/models.json.",
      },
    });
  }

  const parsedModelsDoc = parseJsonSafe(rawModelsText.value);
  if (!isRecord(parsedModelsDoc)) {
    return sparrowSnapshot({
      settings,
      checkedAt,
      slashCommands,
      skills,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Invalid JSON in ${modelsPath}.`,
      },
    });
  }

  const pendingProvider =
    typeof parsedModelsDoc.setupPendingProvider === "string"
      ? nonEmptyTrimmed(parsedModelsDoc.setupPendingProvider)
      : undefined;

  const providersMap = new Map<string, SparrowProviderEntry>();
  const rawProviders = isRecord(parsedModelsDoc.providers) ? parsedModelsDoc.providers : {};
  for (const [providerName, entry] of Object.entries(rawProviders)) {
    const parsedEntry = parseProviderEntry(entry);
    if (parsedEntry) providersMap.set(providerName, parsedEntry);
  }

  const chatGptSignedIn = yield* hasValidChatGptAuth(chatGptAuthPath);
  const existingCodex = providersMap.get("openai-codex");
  if ((chatGptSignedIn || existingCodex) && (!existingCodex || existingCodex.models.length === 0)) {
    providersMap.set("openai-codex", {
      api: existingCodex?.api ?? "openai-codex-responses",
      ...(existingCodex?.baseUrl ? { baseUrl: existingCodex.baseUrl } : {}),
      ...(existingCodex?.apiKey ? { apiKey: existingCodex.apiKey } : {}),
      ...(existingCodex?.oauthCachePath ? { oauthCachePath: existingCodex.oauthCachePath } : {}),
      models: SPARROW_BUILTIN_CODEX_MODELS,
    });
  }

  if (
    pendingProvider !== undefined &&
    (providersMap.get(pendingProvider)?.models.length ?? 0) === 0
  ) {
    return sparrowSnapshot({
      settings,
      checkedAt,
      slashCommands,
      skills,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unauthenticated", type: "sparrow", label: pendingProvider },
        message: `Sparrow provider '${pendingProvider}' needs model configuration in ${modelsPath}.`,
      },
    });
  }

  const rawConfigText = yield* fileSystem.readFileString(configPath).pipe(Effect.option);
  const parsedConfig = Option.isSome(rawConfigText)
    ? parseJsonSafe(rawConfigText.value)
    : undefined;
  const configRecord = isRecord(parsedConfig) ? parsedConfig : {};
  const enabledModels = Array.isArray(configRecord.enabledModels)
    ? configRecord.enabledModels.filter((item): item is string => typeof item === "string")
    : undefined;
  const defaultThinkingMap = resolveConfiguredDefaultThinkingLevels(
    configRecord.defaultThinkingLevels,
  );
  const defaultRef =
    typeof configRecord.defaultModel === "string"
      ? parseSparrowModelRef(configRecord.defaultModel)
      : undefined;

  const subProviders: Array<ServerProviderSubProvider> = [];
  const discoveredModels: Array<ServerProviderModel> = [];
  const readyProviders: Array<string> = [];

  for (const [providerName, entry] of providersMap.entries()) {
    const enabledEntries = entry.models.filter((model) =>
      matchesSparrowEnabledModels(enabledModels, providerName, model.id),
    );
    if (enabledEntries.length === 0) continue;

    const unavailableReason = yield* evaluateProviderCredential({
      providerName,
      provider: entry,
      defaultChatGptAuthPath: chatGptAuthPath,
      sparrowHome,
      environment,
    });
    if (unavailableReason) {
      subProviders.push({ name: providerName, unavailableReason });
      continue;
    }

    readyProviders.push(providerName);
    subProviders.push({ name: providerName });
    for (const model of enabledEntries) {
      const isConfiguredDefault =
        defaultRef?.provider === providerName && defaultRef.modelId === model.id;
      const defaultLevel =
        defaultThinkingMap.get(`${providerName}\0${model.id}`) ??
        (isConfiguredDefault ? defaultRef?.thinkingLevel : undefined);
      const descriptor = buildSparrowThoughtLevelDescriptor({
        ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
        ...(model.thinkingLevelMap !== undefined
          ? { thinkingLevelMap: model.thinkingLevelMap }
          : {}),
        ...(defaultLevel !== undefined ? { defaultLevel } : {}),
      });
      discoveredModels.push({
        slug: encodeSparrowAcpModelId(providerName, model.id),
        name: model.name ?? model.id,
        subProvider: providerName,
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: descriptor ? [descriptor] : [],
        }),
      });
    }
  }

  const defaultCandidate =
    (defaultRef?.acpModelId
      ? discoveredModels.find((m) => m.slug === defaultRef.acpModelId)
      : undefined) ?? discoveredModels[0];

  const allModels = providerModelsFromSettings(
    [
      {
        slug: SPARROW_DEFAULT_MODEL_SLUG,
        name: defaultCandidate ? `Default (${defaultCandidate.name})` : "Default",
        isCustom: false,
        isDefault: true,
        capabilities: defaultCandidate?.capabilities ?? null,
      },
      ...discoveredModels,
    ],
    settings.customModels,
    SPARROW_CUSTOM_MODEL_CAPABILITIES,
  );

  if (discoveredModels.length === 0) {
    const firstUnavailable = subProviders.find((sp) => sp.unavailableReason)?.unavailableReason;
    return sparrowSnapshot({
      settings,
      checkedAt,
      models: allModels,
      subProviders,
      slashCommands: slashCommands.length > 0 ? slashCommands : [COMPACT_SLASH_COMMAND],
      skills,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unauthenticated", type: "sparrow" },
        message:
          firstUnavailable ??
          `No enabled models available in ${modelsPath}. Configure a provider or run \`sparrow\`.`,
      },
    });
  }

  const defaultProviderUnavailable = defaultRef?.provider
    ? subProviders.find((sp) => sp.name === defaultRef.provider)?.unavailableReason
    : undefined;

  const [onlyReadyProvider] = readyProviders;
  const authLabel =
    readyProviders.length === 1 && onlyReadyProvider !== undefined
      ? onlyReadyProvider
      : `${readyProviders.length} providers configured`;
  const auth: ServerProviderAuth = {
    status: "authenticated",
    type: "sparrow",
    label: authLabel,
  };

  return sparrowSnapshot({
    settings,
    checkedAt,
    models: allModels,
    subProviders,
    slashCommands,
    skills,
    probe: defaultProviderUnavailable
      ? {
          installed: true,
          version,
          status: "warning",
          auth,
          message: `${defaultProviderUnavailable} Other Sparrow providers are ready.`,
        }
      : {
          installed: true,
          version,
          status: "ready",
          auth,
        },
  });
});
