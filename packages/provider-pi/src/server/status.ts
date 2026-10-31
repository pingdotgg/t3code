import {
  type CustomModelSetting,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type { PiSettings } from "../settings.ts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { buildPiRpcLaunch, resolvePiLaunchArgs } from "./mcpInjection.ts";
import {
  makePiRpcConnection,
  PiRpcError,
  PiRpcTimeoutError,
  piRecordField as recordField,
  piRecordString as recordString,
} from "./rpc.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  EMPTY_PI_MODEL_CAPABILITIES,
  thinkingCapabilitiesForPiModel,
} from "./thinkingCapabilities.ts";
import {
  parsePiDiscoveredCommands,
  withPiBuiltinSlashCommands,
  type PiDiscoveredCommands,
} from "./commands.ts";

const PI_PRESENTATION = {
  displayName: "Pi",
  showInteractionModeToggle: false,
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
  reportsContextWindow: true,
} as const;

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const PI_RPC_DISCOVERY_TIMEOUT_MS = 30_000;
/**
 * get_entries arrived in 0.80.3 and agent_settled landed in source at 0.80.4.
 * Version 0.80.5 was the first published package containing both hooks.
 */
export const MINIMUM_PI_VERSION = "0.80.5";
/** `pi auth check --json --no-refresh` arrived in 0.84.1. */
const PI_AUTH_CHECK_VERSION = "0.84.1";

const decodePiAuthCheck = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ reason: Schema.optional(Schema.String) })),
);

const PI_DEFAULT_MODEL: ServerProviderModel = {
  slug: "default",
  name: "Pi default",
  isCustom: false,
  capabilities: EMPTY_PI_MODEL_CAPABILITIES,
};

interface PiDiscovery extends PiDiscoveredCommands {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly authenticated: boolean;
  /** Pi's active model when Pi lists no model of its provider, so it cannot start a turn. */
  readonly unavailableActiveModel: { readonly provider: string; readonly id: string } | undefined;
}

function piModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  discovered: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    [PI_DEFAULT_MODEL, ...discovered],
    customModels ?? [],
    EMPTY_PI_MODEL_CAPABILITIES,
  );
}

function parseDiscoveredModels(
  data: unknown,
  state: unknown,
): Result.Result<ReadonlyArray<ServerProviderModel>, PiRpcError> {
  const models = recordField(data, "models");
  if (!Array.isArray(models)) {
    return Result.fail(
      new PiRpcError({ operation: "get_available_models", detail: "Invalid model inventory" }),
    );
  }
  const activeModel = recordField(state, "model");
  const activeProvider = recordString(activeModel, "provider");
  const activeModelId = recordString(activeModel, "id");
  const seen = new Set<string>();
  const parsed: Array<ServerProviderModel> = [];
  for (const model of models) {
    const provider = recordString(model, "provider");
    const id = recordString(model, "id");
    if (provider === undefined || id === undefined || provider.trim() === "" || id.trim() === "") {
      return Result.fail(
        new PiRpcError({ operation: "get_available_models", detail: "Invalid model identity" }),
      );
    }
    const slug = `${provider}/${id}`;
    if (seen.has(slug)) continue;
    seen.add(slug);
    parsed.push({
      slug,
      name: recordString(model, "name") ?? slug,
      subProvider: provider,
      isCustom: false,
      capabilities: thinkingCapabilitiesForPiModel(
        model,
        provider === activeProvider && id === activeModelId
          ? recordString(state, "thinkingLevel")
          : undefined,
      ),
    });
  }
  return Result.succeed(parsed);
}

const makePiDiscoveryConnection = Effect.fnUntraced(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv,
  launchArgs: ReadonlyArray<string>,
  cwd?: string,
) {
  const launch = buildPiRpcLaunch({
    launchArgs,
    environment,
    mcpSession: undefined,
    extensionPath: undefined,
    ephemeral: true,
  });
  const connection = yield* makePiRpcConnection({
    command: piSettings.binaryPath || "pi",
    args: launch.args,
    cwd,
    env: launch.env,
  });
  yield* Stream.fromQueue(connection.events).pipe(
    Stream.runDrain,
    Effect.ignore,
    Effect.forkScoped,
  );
  return connection;
});

const discoverPiViaRpc = Effect.fn("PiProviderStatus.discoverPiViaRpc")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv,
  launchArgs: ReadonlyArray<string>,
  cwd?: string,
) {
  const connection = yield* makePiDiscoveryConnection(piSettings, environment, launchArgs, cwd);
  const stateData = yield* connection.request({ type: "get_state" });
  const modelsData = yield* connection.request({ type: "get_available_models" });
  const commandsData = yield* connection
    .request({ type: "get_commands" })
    .pipe(Effect.orElseSucceed(() => undefined));
  const discoveredModels = yield* Effect.fromResult(parseDiscoveredModels(modelsData, stateData));
  const { slashCommands, skills } = parsePiDiscoveredCommands(commandsData);
  // Pi lists only models of providers it holds credentials for, including extension, virtual and
  // --api-key ones. Turns need only the provider's credentials, so uncatalogued model ids still run.
  const activeModel = recordField(stateData, "model");
  const activeProvider = recordString(activeModel, "provider");
  const activeModelId = recordString(activeModel, "id");
  return {
    models: discoveredModels,
    slashCommands: withPiBuiltinSlashCommands(slashCommands),
    skills,
    authenticated: discoveredModels.length > 0,
    unavailableActiveModel:
      activeProvider !== undefined &&
      activeModelId !== undefined &&
      !discoveredModels.some((model) => model.subProvider === activeProvider)
        ? { provider: activeProvider, id: activeModelId }
        : undefined,
  } satisfies PiDiscovery;
}, Effect.scoped);

export const discoverPiCommandsForCwd = Effect.fn("discoverPiCommandsForCwd")(
  function* (piSettings: PiSettings, environment: NodeJS.ProcessEnv, cwd: string) {
    const launchArgs = resolvePiLaunchArgs(piSettings.launchArgs);
    if (!launchArgs.ok) {
      return yield* new PiRpcError({ operation: "launch", detail: launchArgs.message });
    }
    const connection = yield* makePiDiscoveryConnection(
      piSettings,
      environment,
      launchArgs.args,
      cwd,
    );
    // A failed read must not replace a previously usable workspace catalog with an empty one.
    const commandsData = yield* connection.request({ type: "get_commands" });
    const { slashCommands, skills } = parsePiDiscoveredCommands(commandsData);
    return { slashCommands: withPiBuiltinSlashCommands(slashCommands), skills };
  },
  Effect.scoped,
  Effect.timeoutOrElse({
    duration: PI_RPC_DISCOVERY_TIMEOUT_MS,
    orElse: () =>
      Effect.fail(
        new PiRpcTimeoutError({ operation: "discovery", timeoutMs: PI_RPC_DISCOVERY_TIMEOUT_MS }),
      ),
  }),
);

const runPiVersionCommand = Effect.fn("PiProviderStatus.runPiVersionCommand")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv,
) {
  const command = piSettings.binaryPath || "pi";
  const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
    env: environment,
  });
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
    }),
  );
});

/**
 * Explains why Pi's active model cannot start a turn. On Pi versions with `auth check`, asks it
 * whether credentials are missing, without refreshing or printing them. That command cannot see
 * extension providers or a runtime --api-key, so it only refines Pi's own unavailable verdict,
 * and is skipped when launch args supply the key.
 */
const describeUnavailablePiModel = Effect.fn("PiProviderStatus.describeUnavailablePiModel")(
  function* (
    piSettings: PiSettings,
    environment: NodeJS.ProcessEnv,
    version: string,
    launchArgs: ReadonlyArray<string>,
    model: { readonly provider: string; readonly id: string },
  ) {
    const label = `Pi default (${model.provider}/${model.id})`;
    const unavailable = `${label} uses ${model.provider}, which has no available models in Pi. Choose another model, or check that provider's setup and the Pi launch arguments.`;
    if (
      compareSemverVersions(version, PI_AUTH_CHECK_VERSION) < 0 ||
      launchArgs.includes("--api-key")
    ) {
      return unavailable;
    }
    const command = piSettings.binaryPath || "pi";
    const output = yield* resolveSpawnCommand(
      command,
      ["auth", "check", "--provider", model.provider, "--json", "--no-refresh"],
      { env: environment },
    ).pipe(
      Effect.flatMap((spawnCommand) =>
        spawnAndCollect(
          command,
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            env: environment,
            shell: spawnCommand.shell,
          }),
        ),
      ),
      Effect.timeout(VERSION_PROBE_TIMEOUT_MS),
      Effect.option,
    );
    const missingCredentials = Option.exists(
      Option.flatMap(output, (result) => decodePiAuthCheck(result.stdout)),
      (check) => check.reason === "credentials_not_configured",
    );
    return missingCredentials
      ? `${label} has no credentials configured for ${model.provider}. Choose another model, or run \`pi\` in a terminal and use /login or configure its API key.`
      : unavailable;
  },
);

export const buildInitialPiProviderSnapshot = Effect.fn(
  "PiProviderStatus.buildInitialPiProviderSnapshot",
)(function* (piSettings: PiSettings): Effect.fn.Return<ServerProviderDraft> {
  const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
  const models = piModelsFromSettings(piSettings.customModels);
  if (!piSettings.enabled) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Pi is disabled in T3 Code settings.",
      },
    });
  }
  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Checking Pi CLI availability...",
    },
  });
});

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = piModelsFromSettings(piSettings.customModels);

  if (!piSettings.enabled) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Pi is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runPiVersionCommand(piSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Pi CLI health check failed.", { errorTag: error._tag });
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Pi CLI (`pi`) is not installed or not on PATH. Install with `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`."
          : "Failed to execute Pi CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi CLI is installed but timed out while running `pi --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi CLI is installed but failed to run.",
      },
    });
  }

  if (version === null) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `T3 Code could not determine the Pi version. Pi ${MINIMUM_PI_VERSION} or newer is required.`,
      },
    });
  }

  if (compareSemverVersions(version, MINIMUM_PI_VERSION) < 0) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Pi ${version} is unsupported. Update to Pi ${MINIMUM_PI_VERSION} or newer.`,
      },
    });
  }

  const resolvedLaunchArgs = resolvePiLaunchArgs(piSettings.launchArgs);
  if (!resolvedLaunchArgs.ok) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: resolvedLaunchArgs.message,
      },
    });
  }

  const discoveryExit = yield* discoverPiViaRpc(
    piSettings,
    environment,
    resolvedLaunchArgs.args,
    cwd,
  ).pipe(Effect.timeoutOption(PI_RPC_DISCOVERY_TIMEOUT_MS), Effect.exit);
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("Pi RPC discovery failed.", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "ready",
        auth: { status: "unknown" },
        message:
          "Pi is available, but T3 Code could not refresh its models and commands. The live session will retry startup.",
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "ready",
        auth: { status: "unknown" },
        message:
          "Pi is available, but model and command discovery needs interactive input. The live session will handle it.",
      },
    });
  }

  const discovery = discoveryExit.value.value;
  const models = piModelsFromSettings(piSettings.customModels, discovery.models);
  const message = !discovery.authenticated
    ? "Pi has no usable models. Run `pi` in a terminal and use /login, or configure an API key in ~/.pi/agent."
    : discovery.unavailableActiveModel === undefined
      ? undefined
      : yield* describeUnavailablePiModel(
          piSettings,
          environment,
          version,
          resolvedLaunchArgs.args,
          discovery.unavailableActiveModel,
        );
  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: piSettings.enabled,
    checkedAt,
    models,
    slashCommands: discovery.slashCommands,
    skills: discovery.skills,
    probe: {
      installed: true,
      version,
      // Other Pi models still work when only the default is unavailable, so keep the picker usable.
      status: discovery.authenticated ? "ready" : "warning",
      auth: { status: discovery.authenticated ? "authenticated" : "unauthenticated", type: "pi" },
      ...(message === undefined ? {} : { message }),
    },
  });
});

export const enrichPiSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
}): Effect.Effect<
  void,
  never,
  HttpClient.HttpClient | ProviderLatestVersions.ProviderLatestVersions
> => {
  const { snapshot, publishSnapshot } = input;
  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Pi version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
