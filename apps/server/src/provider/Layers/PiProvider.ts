import {
  type ModelCapabilities,
  type PiSettings,
  ProviderDriverKind,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  detailFromResult,
  parseGenericCliVersion,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  piAgentDir,
  readPiLocalSettings,
  runPiCommand,
  runPiRpcCommands,
  type PiLocalSettings,
  type PiRpcModel,
  type PiRpcSlashCommand,
} from "./PiRpc.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const PI_PRESENTATION = {
  displayName: "Pi",
  showInteractionModeToggle: true,
} as const;

const DEFAULT_PI_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

const BUILT_IN_SLASH_COMMANDS: ReadonlyArray<ServerProviderSlashCommand> = [
  { name: "settings", description: "Open or inspect Pi settings in Pi-native contexts" },
  { name: "model", description: "Change the active Pi model" },
  { name: "scoped-models", description: "Adjust Pi model cycling scope" },
  { name: "export", description: "Export the Pi session when supported by the runtime" },
  { name: "import", description: "Import Pi session content in Pi-native contexts" },
  { name: "share", description: "Share the Pi session in Pi-native contexts" },
  { name: "copy", description: "Copy Pi output in Pi-native contexts" },
  { name: "name", description: "Set the Pi session name", input: { hint: "name" } },
  { name: "session", description: "Show or switch Pi session information" },
  { name: "changelog", description: "Show Pi changelog in Pi-native contexts" },
  { name: "hotkeys", description: "Show Pi hotkeys in Pi-native contexts" },
  { name: "fork", description: "Fork the current Pi session when an entry id is available" },
  { name: "clone", description: "Clone the current Pi session" },
  { name: "tree", description: "Show Pi session tree in Pi-native contexts" },
  { name: "login", description: "Start Pi login in Pi-native contexts" },
  { name: "logout", description: "Start Pi logout in Pi-native contexts" },
  { name: "new", description: "Start a new Pi session" },
  {
    name: "compact",
    description: "Compact the current Pi session",
    input: { hint: "instructions" },
  },
  { name: "resume", description: "Resume a Pi session in Pi-native contexts" },
  { name: "reload", description: "Reload Pi configuration in Pi-native contexts" },
  { name: "quit", description: "Quit Pi in Pi-native contexts" },
];

function piModelCapabilities(model: PiRpcModel, settings: PiLocalSettings): ModelCapabilities {
  if (model.reasoning !== true) return DEFAULT_PI_MODEL_CAPABILITIES;
  const defaultThinking = settings.defaultThinkingLevel;
  return createModelCapabilities({
    optionDescriptors: [
      buildSelectOptionDescriptor({
        id: "thinkingLevel",
        label: "Thinking",
        options: THINKING_LEVELS.map((level) => ({
          value: level,
          label: level === "xhigh" ? "Extra High" : level[0]!.toUpperCase() + level.slice(1),
          isDefault: defaultThinking === level,
        })),
      }),
    ],
  });
}

function modelSlug(model: PiRpcModel): string | null {
  const provider = model.provider?.trim();
  const id = model.id?.trim();
  if (!provider || !id) return null;
  return `${provider}/${id}`;
}

function preferredIndex(model: PiRpcModel, settings: PiLocalSettings, slug: string): number | null {
  const defaultSlug =
    settings.defaultProvider && settings.defaultModel
      ? `${settings.defaultProvider}/${settings.defaultModel}`
      : null;
  if (defaultSlug === slug || defaultSlug === model.id) return -1;

  const enabledModels = settings.enabledModels ?? [];
  for (let index = 0; index < enabledModels.length; index += 1) {
    const pattern = enabledModels[index]?.split(":")[0]?.trim();
    if (!pattern) continue;
    if (
      pattern === slug ||
      pattern === model.id ||
      slug.endsWith(`/${pattern}`) ||
      model.name?.toLowerCase() === pattern.toLowerCase()
    ) {
      return index;
    }
  }
  return null;
}

export function piModelsToServerModels(
  models: ReadonlyArray<PiRpcModel>,
  settings: PiLocalSettings,
): ReadonlyArray<ServerProviderModel> {
  const mapped = models.flatMap((model) => {
    const slug = modelSlug(model);
    if (!slug) return [];
    return [
      {
        slug,
        name: model.name?.trim() || model.id,
        shortName: model.id,
        subProvider: model.provider,
        isCustom: false,
        capabilities: piModelCapabilities(model, settings),
        preferred: preferredIndex(model, settings, slug),
      },
    ];
  });

  return mapped
    .toSorted((left, right) => {
      const leftPreferred = left.preferred;
      const rightPreferred = right.preferred;
      if (leftPreferred !== null && rightPreferred !== null && leftPreferred !== rightPreferred) {
        return leftPreferred - rightPreferred;
      }
      if (leftPreferred !== null && rightPreferred === null) return -1;
      if (leftPreferred === null && rightPreferred !== null) return 1;
      return `${left.subProvider ?? ""}/${left.name}`.localeCompare(
        `${right.subProvider ?? ""}/${right.name}`,
      );
    })
    .map(({ preferred: _preferred, ...model }) => model);
}

function dedupeSlashCommands(
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const byName = new Map<string, ServerProviderSlashCommand>();
  for (const command of commands) {
    const name = command.name.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (!byName.has(key)) byName.set(key, { ...command, name });
  }
  return Array.from(byName.values()).toSorted((left, right) => left.name.localeCompare(right.name));
}

function dynamicCommandsToSlashCommands(
  commands: ReadonlyArray<PiRpcSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  return commands.flatMap((command) => {
    const name = command.name?.trim().replace(/^\/+/, "");
    if (!name) return [];
    return [
      {
        name,
        ...(command.description?.trim() ? { description: command.description.trim() } : {}),
      },
    ];
  });
}

export const makePendingPiProvider = (piSettings: PiSettings): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: providerModelsFromSettings(
        [],
        PROVIDER,
        piSettings.customModels,
        DEFAULT_PI_MODEL_CAPABILITIES,
      ),
      slashCommands: BUILT_IN_SLASH_COMMANDS,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown", type: "pi" },
        message: piSettings.enabled
          ? "Pi provider status has not been checked in this session yet."
          : "Pi is disabled in T3 Code settings.",
      },
    });
  });

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  piSettings: PiSettings,
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = providerModelsFromSettings(
    [],
    PROVIDER,
    piSettings.customModels,
    DEFAULT_PI_MODEL_CAPABILITIES,
  );

  if (!piSettings.enabled) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      slashCommands: BUILT_IN_SLASH_COMMANDS,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown", type: "pi" },
        message: "Pi is disabled in T3 Code settings.",
      },
    });
  }

  const versionExit = yield* Effect.exit(
    Effect.tryPromise(() =>
      runPiCommand({
        binaryPath: piSettings.binaryPath,
        args: ["--version"],
        cwd,
        environment,
        timeoutMs: 10_000,
      }),
    ),
  );
  if (versionExit._tag === "Failure") {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      slashCommands: BUILT_IN_SLASH_COMMANDS,
      probe: {
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown", type: "pi" },
        message: `Unable to run Pi at '${piSettings.binaryPath}'.`,
      },
    });
  }

  const versionResult = versionExit.value;
  const version =
    parseGenericCliVersion(versionResult.stdout) ?? parseGenericCliVersion(versionResult.stderr);
  if (versionResult.code !== 0) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      slashCommands: BUILT_IN_SLASH_COMMANDS,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown", type: "pi" },
        message: detailFromResult(versionResult) ?? "Pi version check failed.",
      },
    });
  }

  const settings = yield* Effect.tryPromise(() => readPiLocalSettings(environment)).pipe(
    Effect.catch(() => Effect.succeed({} satisfies PiLocalSettings)),
  );

  const inventoryExit = yield* Effect.exit(
    Effect.tryPromise(() =>
      runPiRpcCommands({
        binaryPath: piSettings.binaryPath,
        commands: [
          { id: "models", type: "get_available_models" },
          { id: "commands", type: "get_commands" },
        ],
        cwd,
        environment,
        timeoutMs: 20_000,
      }),
    ),
  );

  if (inventoryExit._tag === "Failure") {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      slashCommands: BUILT_IN_SLASH_COMMANDS,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unknown", type: "pi" },
        message: `Pi is installed, but model discovery failed while reading ${piAgentDir(environment)}.`,
      },
    });
  }

  const modelResponse = inventoryExit.value.responses.get("models");
  const commandResponse = inventoryExit.value.responses.get("commands");
  const piModels =
    modelResponse?.data &&
    typeof modelResponse.data === "object" &&
    Array.isArray((modelResponse.data as { models?: unknown }).models)
      ? ((modelResponse.data as { models: PiRpcModel[] }).models ?? [])
      : [];
  const dynamicCommands =
    commandResponse?.data &&
    typeof commandResponse.data === "object" &&
    Array.isArray((commandResponse.data as { commands?: unknown }).commands)
      ? ((commandResponse.data as { commands: PiRpcSlashCommand[] }).commands ?? [])
      : [];

  const models = providerModelsFromSettings(
    piModelsToServerModels(piModels, settings),
    PROVIDER,
    piSettings.customModels,
    DEFAULT_PI_MODEL_CAPABILITIES,
  );
  const slashCommands = dedupeSlashCommands([
    ...BUILT_IN_SLASH_COMMANDS,
    ...dynamicCommandsToSlashCommands(dynamicCommands),
  ]);

  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    slashCommands,
    probe: {
      installed: true,
      version,
      status: models.length > 0 ? "ready" : "warning",
      auth: { status: models.length > 0 ? "authenticated" : "unknown", type: "pi" },
      message:
        models.length > 0
          ? `Pi is available using existing config at ${piAgentDir(environment)}.`
          : `Pi is installed, but no available models were reported from ${piAgentDir(environment)}.`,
    },
  });
});
