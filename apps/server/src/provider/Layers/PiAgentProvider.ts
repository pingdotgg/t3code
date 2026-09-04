/**
 * Provider status and catalog discovery for the Pi coding agent.
 *
 * Pi is deliberately user-managed: T3 Code does not install, update, or
 * authenticate its binary. The status check only runs the configured binary
 * and a short-lived RPC process, then closes that process before publishing a
 * snapshot. Model and slash-command metadata come from Pi's RPC inventory so
 * a profile can expose its own providers and extensions.
 *
 * @module provider/Layers/PiAgentProvider
 */
import type {
  ModelCapabilities,
  PiAgentSettings,
  ServerProviderModel,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { expandHomePath } from "../../pathExpansion.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  makePiRpcClient,
  PiRpcClientError,
  type PiRpcRequestCommand,
  type PiRpcClient,
  type PiRpcClientOptions,
} from "../pi/PiRpcClient.ts";
import type { PiRpcResponse } from "../pi/PiRpcProtocol.ts";

const PI_BINARY = "pi";
const PI_RPC_TIMEOUT = "6 seconds";
const PI_VERSION_TIMEOUT = "4 seconds";

export const PI_AGENT_PRESENTATION = {
  displayName: "Pi Agent",
  badgeLabel: "Early Access",
  // Pi RPC has no T3 plan-mode contract. Permission modes are advertised
  // separately through `supportedRuntimeModes` below.
  showInteractionModeToggle: false,
} as const;

const EMPTY_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function arrayFromResponse(data: unknown, keys: ReadonlyArray<string>): ReadonlyArray<unknown> {
  if (Array.isArray(data)) return data;
  if (!isRecord(data)) return [];
  for (const key of keys) {
    if (Array.isArray(data[key])) return data[key];
  }
  return [];
}

function responseData(response: PiRpcResponse | undefined): unknown {
  return response?.success === true ? response.data : undefined;
}

function responseStringList(
  response: PiRpcResponse | undefined,
  keys: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return arrayFromResponse(responseData(response), keys).flatMap((entry) => {
    if (typeof entry === "string") {
      const value = stringValue(entry);
      return value ? [value] : [];
    }
    if (!isRecord(entry)) return [];
    const value =
      stringValue(entry.id) ??
      stringValue(entry.value) ??
      stringValue(entry.name) ??
      stringValue(entry.level);
    return value ? [value] : [];
  });
}

function uniqueStrings(values: ReadonlyArray<string>): ReadonlyArray<string> {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function thinkingCapabilities(
  thinkingLevels: ReadonlyArray<string>,
  currentThinkingLevel?: string,
): ModelCapabilities {
  const levels = uniqueStrings(thinkingLevels);
  if (levels.length === 0) return EMPTY_MODEL_CAPABILITIES;
  const defaultLevel =
    currentThinkingLevel && levels.includes(currentThinkingLevel)
      ? currentThinkingLevel
      : levels.includes("medium")
        ? "medium"
        : levels[0];
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Thinking",
        type: "select",
        options: levels.map((level) => ({
          id: level,
          label: level.charAt(0).toUpperCase() + level.slice(1),
          ...(level === defaultLevel ? { isDefault: true } : {}),
        })),
        currentValue: defaultLevel,
      },
    ],
  });
}

function modelSlug(model: UnknownRecord): string | undefined {
  const provider = stringValue(model.provider) ?? stringValue(model.providerId);
  const id =
    stringValue(model.id) ??
    stringValue(model.modelId) ??
    stringValue(model.slug) ??
    stringValue(model.name);
  if (!id) return undefined;
  return provider && !id.includes("/") ? `${provider}/${id}` : id;
}

function isUnknownPiModel(slug: string): boolean {
  return slug.toLowerCase() === "unknown/unknown";
}

function modelName(model: UnknownRecord, slug: string): string {
  return (
    stringValue(model.name) ?? stringValue(model.displayName) ?? stringValue(model.label) ?? slug
  );
}

function modelThinkingLevels(model: UnknownRecord): ReadonlyArray<string> {
  if (!isRecord(model.thinkingLevelMap)) return [];
  return uniqueStrings(
    Object.values(model.thinkingLevelMap).flatMap((value) => {
      const level = stringValue(value);
      return level ? [level] : [];
    }),
  );
}

function currentModelSlug(state: unknown): string | undefined {
  if (!isRecord(state)) return undefined;
  const current = state.model;
  if (typeof current === "string") return stringValue(current);
  return isRecord(current) ? modelSlug(current) : undefined;
}

/**
 * Convert Pi's intentionally loose model inventory into T3's model picker
 * shape. Pi profiles commonly return `{ provider, id, name }`, but accepting
 * `modelId`/`slug` keeps this hook compatible with older Pi builds and forks.
 */
export function buildPiAgentModels(input: {
  readonly response: unknown;
  readonly state?: unknown;
  readonly thinkingLevels?: ReadonlyArray<string>;
}): ReadonlyArray<ServerProviderModel> {
  const currentThinkingLevel = isRecord(input.state)
    ? stringValue(input.state.thinkingLevel)
    : undefined;
  const currentCapabilities = thinkingCapabilities(
    input.thinkingLevels ?? [],
    currentThinkingLevel,
  );
  const models = arrayFromResponse(input.response, ["models", "availableModels", "available"]);
  const current = currentModelSlug(input.state);
  const seen = new Set<string>();
  const result: ServerProviderModel[] = [];

  for (const entry of models) {
    if (!isRecord(entry)) continue;
    const slug = modelSlug(entry);
    if (!slug || isUnknownPiModel(slug) || seen.has(slug)) continue;
    seen.add(slug);
    const advertisedThinkingLevels = modelThinkingLevels(entry);
    const capabilities = thinkingCapabilities(
      advertisedThinkingLevels.length > 0
        ? advertisedThinkingLevels
        : current === slug
          ? (input.thinkingLevels ?? [])
          : [],
      current === slug ? currentThinkingLevel : undefined,
    );
    result.push({
      slug,
      name: modelName(entry, slug),
      isCustom: false,
      ...(current === slug ? { isDefault: true } : {}),
      capabilities,
    });
  }

  // A Pi version may expose the active model through get_state but not publish
  // its inventory until a provider is authenticated. Keep that active model
  // selectable instead of returning an empty picker.
  if (result.length === 0 && isRecord(input.state) && isRecord(input.state.model)) {
    const active = input.state.model;
    const slug = modelSlug(active);
    if (slug && !isUnknownPiModel(slug)) {
      result.push({
        slug,
        name: modelName(active, slug),
        isCustom: false,
        isDefault: true,
        capabilities: currentCapabilities,
      });
    }
  }
  return result;
}

function commandName(command: UnknownRecord): string | undefined {
  return stringValue(command.name) ?? stringValue(command.id) ?? stringValue(command.command);
}

function isPiSkillCommand(command: UnknownRecord, name: string): boolean {
  return command.source === "skill" && name.startsWith("skill:");
}

/** Convert Pi's manual skill commands into T3's shared skill-picker shape. */
export function buildPiAgentSkills(response: unknown): ReadonlyArray<ServerProviderSkill> {
  const commands = arrayFromResponse(response, ["commands", "availableCommands"]);
  const seen = new Set<string>();
  const result: ServerProviderSkill[] = [];
  for (const entry of commands) {
    if (!isRecord(entry)) continue;
    const command = commandName(entry);
    if (!command || !isPiSkillCommand(entry, command)) continue;
    const name = stringValue(command.slice("skill:".length));
    const sourceInfo = isRecord(entry.sourceInfo) ? entry.sourceInfo : undefined;
    const skillPath = sourceInfo ? stringValue(sourceInfo.path) : undefined;
    if (!name || !skillPath || seen.has(name)) continue;
    seen.add(name);
    const description = stringValue(entry.description) ?? stringValue(entry.help);
    const scope = sourceInfo ? stringValue(sourceInfo.scope) : undefined;
    result.push({
      name,
      path: skillPath,
      enabled: true,
      ...(description ? { description, shortDescription: description } : {}),
      ...(scope ? { scope } : {}),
    });
  }
  return result;
}

/** Convert Pi extension commands into the slash-command wire shape. */
export function buildPiAgentSlashCommands(
  response: unknown,
): ReadonlyArray<ServerProviderSlashCommand> {
  const commands = arrayFromResponse(response, ["commands", "availableCommands"]);
  const seen = new Set<string>();
  const result: ServerProviderSlashCommand[] = [];
  for (const entry of commands) {
    if (!isRecord(entry)) continue;
    const name = commandName(entry);
    if (!name || isPiSkillCommand(entry, name) || seen.has(name)) continue;
    seen.add(name);
    const description = stringValue(entry.description) ?? stringValue(entry.help);
    const hint =
      stringValue(entry.hint) ??
      stringValue(entry.inputHint) ??
      (isRecord(entry.input) ? stringValue(entry.input.hint) : undefined);
    result.push({
      name,
      ...(description ? { description } : {}),
      ...(hint ? { input: { hint } } : {}),
    });
  }
  return result;
}

export function providerModelsFromPiCatalog(
  models: ReadonlyArray<ServerProviderModel>,
  customModels: ReadonlyArray<string>,
): ReadonlyArray<ServerProviderModel> {
  // The built-in entries already carry capabilities for the selected model;
  // custom entries have no model-specific probe, so leave them conservative.
  return providerModelsFromSettings(models, customModels, EMPTY_MODEL_CAPABILITIES);
}

export interface PiAgentCatalog {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly thinkingLevels: ReadonlyArray<string>;
  readonly state: unknown;
}

export interface PiAgentClientFactory {
  readonly makeClient: (
    options: PiRpcClientOptions,
  ) => Effect.Effect<PiRpcClient, unknown, Scope.Scope>;
}

function rpcArgs(settings: PiAgentSettings, shortLived: boolean): ReadonlyArray<string> {
  const sessionDir = expandHomePath(settings.sessionDir.trim());
  return [
    "--mode",
    "rpc",
    ...(shortLived ? ["--no-session"] : []),
    ...(sessionDir ? ["--session-dir", sessionDir] : []),
  ];
}

function rpcEnvironment(
  settings: PiAgentSettings,
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) next[key] = value;
  }
  const agentDir = expandHomePath(settings.agentDir.trim());
  if (agentDir) next.PI_CODING_AGENT_DIR = agentDir;
  return next;
}

const requestOptional = (client: PiRpcClient, command: PiRpcRequestCommand) =>
  client
    .request(command)
    .pipe(Effect.timeoutOption(PI_RPC_TIMEOUT), Effect.map(Option.getOrUndefined));

/**
 * Probe one Pi profile's dynamic catalog. `factory` is injectable so the
 * parser and driver can be tested without starting a real user binary.
 */
export const discoverPiAgentCatalog = Effect.fn("discoverPiAgentCatalog")(function* (
  settings: PiAgentSettings,
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
  factory?: PiAgentClientFactory,
): Effect.fn.Return<
  PiAgentCatalog,
  PiRpcClientError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  const clientOptions = {
    binaryPath: expandHomePath(settings.binaryPath || PI_BINARY),
    args: rpcArgs(settings, true),
    cwd,
    env: rpcEnvironment(settings, environment),
  } satisfies PiRpcClientOptions;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const client = yield* (
    factory?.makeClient(clientOptions).pipe(
      Effect.mapError(
        (cause) =>
          new PiRpcClientError({
            operation: "spawn",
            detail: "Could not start Pi Agent RPC for catalog discovery.",
            cause,
          }),
      ),
    ) ??
      makePiRpcClient(clientOptions).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      )
  );

  const [stateResponse, modelsResponse, thinkingResponse, commandsResponse] = yield* Effect.all(
    [
      requestOptional(client, { type: "get_state" }),
      requestOptional(client, { type: "get_available_models" }),
      requestOptional(client, { type: "get_available_thinking_levels" }),
      requestOptional(client, { type: "get_commands" }),
    ],
    { concurrency: "unbounded" },
  );
  const state = responseData(stateResponse);
  const thinkingLevels = uniqueStrings(
    responseStringList(thinkingResponse, ["levels", "thinkingLevels", "available"]),
  );
  return {
    models: buildPiAgentModels({
      response: responseData(modelsResponse),
      state,
      thinkingLevels,
    }),
    slashCommands: buildPiAgentSlashCommands(responseData(commandsResponse)),
    skills: buildPiAgentSkills(responseData(commandsResponse)),
    thinkingLevels,
    state,
  };
});

const runPiVersion = Effect.fn("runPiVersion")(function* (
  settings: PiAgentSettings,
  environment: NodeJS.ProcessEnv,
) {
  const binaryPath = expandHomePath(settings.binaryPath || PI_BINARY);
  const spawnCommand = yield* resolveSpawnCommand(binaryPath, ["--version"], {
    env: environment,
    extendEnv: true,
  });
  return yield* spawnAndCollect(
    binaryPath,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      extendEnv: true,
      shell: spawnCommand.shell,
    }),
  );
});

function piMissingBinary(cause: unknown): boolean {
  if (isCommandMissingCause(cause)) return true;
  if (!isRecord(cause)) return false;
  return cause.code === "ENOENT" || /not found|enoent/i.test(String(cause.message ?? ""));
}

function buildPiAgentProvider(input: {
  readonly settings: PiAgentSettings;
  readonly checkedAt: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly slashCommands?: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills?: ReadonlyArray<ServerProviderSkill>;
  readonly installed: boolean;
  readonly version: string | null;
  readonly status: "ready" | "warning" | "error";
  readonly message?: string;
}): ServerProviderDraft {
  // `supportsTextGeneration` is intentionally explicit: generic Git/source
  // control flows must not silently choose Pi for structured text generation.
  return {
    ...buildServerProvider({
      presentation: PI_AGENT_PRESENTATION,
      enabled: input.settings.enabled,
      checkedAt: input.checkedAt,
      models: input.models,
      slashCommands: input.slashCommands ?? [],
      skills: input.skills ?? [],
      probe: {
        installed: input.installed,
        version: input.version,
        status: input.status,
        auth: { status: "unknown" },
        ...(input.message ? { message: input.message } : {}),
      },
    }),
    supportsTextGeneration: false,
    supportsConversationRollback: false,
    supportedRuntimeModes: ["full-access"],
  };
}

export const makePendingPiAgentProvider = (
  settings: PiAgentSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.map(DateTime.now, (now) =>
    buildPiAgentProvider({
      settings,
      checkedAt: DateTime.formatIso(now),
      models: providerModelsFromSettings([], settings.customModels, EMPTY_MODEL_CAPABILITIES),
      installed: false,
      version: null,
      status: "warning",
      message: settings.enabled
        ? "Checking Pi Agent availability..."
        : "Pi Agent is disabled in T3 Code settings.",
    }),
  );

export const checkPiAgentProviderStatus = Effect.fn("checkPiAgentProviderStatus")(function* (
  settings: PiAgentSettings,
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
  factory?: PiAgentClientFactory,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = providerModelsFromSettings(
    [],
    settings.customModels,
    EMPTY_MODEL_CAPABILITIES,
  );
  if (!settings.enabled) {
    return buildPiAgentProvider({
      settings,
      checkedAt,
      models: fallbackModels,
      installed: false,
      version: null,
      status: "warning",
      message: "Pi Agent is disabled in T3 Code settings.",
    });
  }

  const versionExit = yield* Effect.exit(
    runPiVersion(settings, environment).pipe(Effect.timeout(PI_VERSION_TIMEOUT)),
  );
  if (Exit.isFailure(versionExit)) {
    const cause = Cause.squash(versionExit.cause);
    return buildPiAgentProvider({
      settings,
      checkedAt,
      models: fallbackModels,
      installed: !piMissingBinary(cause),
      version: null,
      status: "error",
      message: piMissingBinary(cause)
        ? `Pi Agent binary ('${settings.binaryPath || PI_BINARY}') was not found. Install Pi yourself or set Binary path in provider settings.`
        : "Pi Agent binary was found but failed its version probe.",
    });
  }

  const versionResult = versionExit.value;
  const version = parseGenericCliVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
  if (versionResult.code !== 0) {
    return buildPiAgentProvider({
      settings,
      checkedAt,
      models: fallbackModels,
      installed: true,
      version,
      status: "error",
      message: "Pi Agent is installed but its version command failed.",
    });
  }

  const catalogExit = yield* Effect.exit(
    discoverPiAgentCatalog(settings, cwd, environment, factory).pipe(
      Effect.timeout(PI_RPC_TIMEOUT),
      Effect.scoped,
    ),
  );
  if (Exit.isFailure(catalogExit)) {
    return buildPiAgentProvider({
      settings,
      checkedAt,
      models: fallbackModels,
      installed: true,
      version,
      status: "warning",
      message: "Pi Agent is installed, but dynamic model and command discovery failed.",
    });
  }

  const models = providerModelsFromPiCatalog(catalogExit.value.models, settings.customModels);
  const hasUsableCatalog = models.length > 0;

  return buildPiAgentProvider({
    settings,
    checkedAt,
    models,
    slashCommands: catalogExit.value.slashCommands,
    skills: catalogExit.value.skills,
    installed: true,
    version,
    status: hasUsableCatalog ? "ready" : "warning",
    ...(hasUsableCatalog
      ? {}
      : {
          message:
            "Pi Agent is installed, but no usable models were reported. Configure a model in Pi or add a custom model in provider settings.",
        }),
  });
});
