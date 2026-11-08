import {
  type CustomModelSetting,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type { OmpSettings } from "../settings.ts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { buildOmpRpcLaunch, resolveOmpLaunchArgs } from "./mcpInjection.ts";
import {
  makeOmpRpcConnection,
  OmpRpcError,
  OmpRpcTimeoutError,
  ompRecordField as recordField,
  ompRecordString as recordString,
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
  EMPTY_OMP_MODEL_CAPABILITIES,
  thinkingCapabilitiesForOmpModel,
} from "./thinkingCapabilities.ts";
import {
  parseOmpDiscoveredCommands,
  withOmpBuiltinSlashCommands,
  type OmpDiscoveredCommands,
} from "./commands.ts";

const OMP_PRESENTATION = {
  displayName: "OMP",
  showInteractionModeToggle: false,
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
  reportsContextWindow: true,
} as const;

const VERSION_PROBE_TIMEOUT_MS = 10_000;
const OMP_RPC_DISCOVERY_TIMEOUT_MS = 30_000;
// Minimum version verified against the native RPC protocol.
export const MINIMUM_OMP_VERSION = "18.16.0";

const OMP_DEFAULT_MODEL: ServerProviderModel = {
  slug: "default",
  name: "Omp default",
  isCustom: false,
  capabilities: EMPTY_OMP_MODEL_CAPABILITIES,
};

interface OmpDiscovery extends OmpDiscoveredCommands {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly authenticated: boolean;
  /** Omp's active model when Omp lists no model of its provider, so it cannot start a turn. */
  readonly unavailableActiveModel: { readonly provider: string; readonly id: string } | undefined;
}

function ompModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  discovered: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    [OMP_DEFAULT_MODEL, ...discovered],
    customModels ?? [],
    EMPTY_OMP_MODEL_CAPABILITIES,
  );
}

function parseDiscoveredModels(
  data: unknown,
  state: unknown,
): Result.Result<ReadonlyArray<ServerProviderModel>, OmpRpcError> {
  const models = recordField(data, "models");
  if (!Array.isArray(models)) {
    return Result.fail(
      new OmpRpcError({ operation: "get_available_models", detail: "Invalid model inventory" }),
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
        new OmpRpcError({ operation: "get_available_models", detail: "Invalid model identity" }),
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
      capabilities: thinkingCapabilitiesForOmpModel(
        model,
        provider === activeProvider && id === activeModelId
          ? recordString(state, "thinkingLevel")
          : undefined,
      ),
    });
  }
  return Result.succeed(parsed);
}

const makeOmpDiscoveryConnection = Effect.fnUntraced(function* (
  ompSettings: OmpSettings,
  environment: NodeJS.ProcessEnv,
  launchArgs: ReadonlyArray<string>,
  cwd?: string,
) {
  const launch = buildOmpRpcLaunch({
    launchArgs,
    environment,
    mcpSession: undefined,
    extensionPath: undefined,
    ephemeral: true,
    shortLived: true,
  });
  const connection = yield* makeOmpRpcConnection({
    command: ompSettings.binaryPath || "omp",
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

const discoverOmpViaRpc = Effect.fn("OmpProviderStatus.discoverOmpViaRpc")(function* (
  ompSettings: OmpSettings,
  environment: NodeJS.ProcessEnv,
  launchArgs: ReadonlyArray<string>,
  cwd?: string,
) {
  const connection = yield* makeOmpDiscoveryConnection(ompSettings, environment, launchArgs, cwd);
  const stateData = yield* connection.request({ type: "get_state" });
  const modelsData = yield* connection.request({ type: "get_available_models" });
  const commandsData = yield* connection
    .request({ type: "get_available_commands" })
    .pipe(Effect.orElseSucceed(() => undefined));
  const discoveredModels = yield* Effect.fromResult(parseDiscoveredModels(modelsData, stateData));
  const { slashCommands, skills } = parseOmpDiscoveredCommands(commandsData);
  // Omp lists only models of providers it holds credentials for, including extension, virtual and
  // --api-key ones. Turns need only the provider's credentials, so uncatalogued model ids still run.
  const activeModel = recordField(stateData, "model");
  const activeProvider = recordString(activeModel, "provider");
  const activeModelId = recordString(activeModel, "id");
  return {
    models: discoveredModels,
    slashCommands: withOmpBuiltinSlashCommands(slashCommands),
    skills,
    authenticated: discoveredModels.length > 0,
    unavailableActiveModel:
      activeProvider !== undefined &&
      activeModelId !== undefined &&
      !discoveredModels.some((model) => model.subProvider === activeProvider)
        ? { provider: activeProvider, id: activeModelId }
        : undefined,
  } satisfies OmpDiscovery;
}, Effect.scoped);

export const discoverOmpCommandsForCwd = Effect.fn("discoverOmpCommandsForCwd")(
  function* (ompSettings: OmpSettings, environment: NodeJS.ProcessEnv, cwd: string) {
    const launchArgs = resolveOmpLaunchArgs(ompSettings.launchArgs);
    if (!launchArgs.ok) {
      return yield* new OmpRpcError({ operation: "launch", detail: launchArgs.message });
    }
    const connection = yield* makeOmpDiscoveryConnection(
      ompSettings,
      environment,
      launchArgs.args,
      cwd,
    );
    // A failed read must not replace a previously usable workspace catalog with an empty one.
    const commandsData = yield* connection.request({ type: "get_available_commands" });
    const { slashCommands, skills } = parseOmpDiscoveredCommands(commandsData);
    return { slashCommands: withOmpBuiltinSlashCommands(slashCommands), skills };
  },
  Effect.scoped,
  Effect.timeoutOrElse({
    duration: OMP_RPC_DISCOVERY_TIMEOUT_MS,
    orElse: () =>
      Effect.fail(
        new OmpRpcTimeoutError({ operation: "discovery", timeoutMs: OMP_RPC_DISCOVERY_TIMEOUT_MS }),
      ),
  }),
);

const runOmpVersionCommand = Effect.fn("OmpProviderStatus.runOmpVersionCommand")(function* (
  ompSettings: OmpSettings,
  environment: NodeJS.ProcessEnv,
) {
  const command = ompSettings.binaryPath || "omp";
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

export const buildInitialOmpProviderSnapshot = Effect.fn(
  "OmpProviderStatus.buildInitialOmpProviderSnapshot",
)(function* (ompSettings: OmpSettings): Effect.fn.Return<ServerProviderDraft> {
  const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
  const models = ompModelsFromSettings(ompSettings.customModels);
  if (!ompSettings.enabled) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Omp is disabled in T3 Code settings.",
      },
    });
  }
  return buildServerProvider({
    presentation: OMP_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Checking Omp CLI availability...",
    },
  });
});

export const checkOmpProviderStatus = Effect.fn("checkOmpProviderStatus")(function* (
  ompSettings: OmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = ompModelsFromSettings(ompSettings.customModels);

  if (!ompSettings.enabled) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Omp is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runOmpVersionCommand(ompSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Omp CLI health check failed.", { errorTag: error._tag });
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Omp CLI (`omp`) is not installed or not on PATH. Install OMP using its official installer, then set its binary path in provider settings."
          : "Failed to execute Omp CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Omp CLI is installed but timed out while running `omp --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Omp CLI is installed but failed to run.",
      },
    });
  }

  if (version === null) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `T3 Code could not determine the Omp version. Omp ${MINIMUM_OMP_VERSION} or newer is required.`,
      },
    });
  }

  if (compareSemverVersions(version, MINIMUM_OMP_VERSION) < 0) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Omp ${version} is unsupported. Update to Omp ${MINIMUM_OMP_VERSION} or newer.`,
      },
    });
  }

  const resolvedLaunchArgs = resolveOmpLaunchArgs(ompSettings.launchArgs);
  if (!resolvedLaunchArgs.ok) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
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

  const discoveryExit = yield* discoverOmpViaRpc(
    ompSettings,
    environment,
    resolvedLaunchArgs.args,
    cwd,
  ).pipe(Effect.timeoutOption(OMP_RPC_DISCOVERY_TIMEOUT_MS), Effect.exit);
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("Omp RPC discovery failed.", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "ready",
        auth: { status: "unknown" },
        message:
          "Omp is available, but T3 Code could not refresh its models and commands. The live session will retry startup.",
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "ready",
        auth: { status: "unknown" },
        message:
          "Omp is available, but model and command discovery needs interactive input. The live session will handle it.",
      },
    });
  }

  const discovery = discoveryExit.value.value;
  const models = ompModelsFromSettings(ompSettings.customModels, discovery.models);
  const message = !discovery.authenticated
    ? "Omp has no usable models. Run `omp` in a terminal and use /login, or configure an API key in ~/.omp/agent."
    : discovery.unavailableActiveModel === undefined
      ? undefined
      : `Omp default (${discovery.unavailableActiveModel.provider}/${discovery.unavailableActiveModel.id}) is unavailable. Choose another model or configure that provider in OMP.`;
  return buildServerProvider({
    presentation: OMP_PRESENTATION,
    enabled: ompSettings.enabled,
    checkedAt,
    models,
    slashCommands: discovery.slashCommands,
    skills: discovery.skills,
    probe: {
      installed: true,
      version,
      // Other Omp models still work when only the default is unavailable, so keep the picker usable.
      status: discovery.authenticated ? "ready" : "warning",
      auth: { status: discovery.authenticated ? "authenticated" : "unauthenticated", type: "omp" },
      ...(message === undefined ? {} : { message }),
    },
  });
});

export const enrichOmpSnapshot = (input: {
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
      Effect.logWarning("Omp version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
