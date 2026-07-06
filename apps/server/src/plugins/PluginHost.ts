import {
  HOST_API_VERSION,
  PluginManifest,
  hostApiSatisfies,
  type PluginId,
  type PluginLockfile,
  type PluginLockfilePlugin,
  type PluginState,
} from "@t3tools/contracts/plugin";
import type {
  PluginDefinition,
  PluginHostApi,
  PluginLogger,
  PluginRegistration,
  PluginServiceDescriptor,
} from "@t3tools/plugin-sdk";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerLifecycleEvents from "../serverLifecycleEvents.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProjectionThreadActivities from "../persistence/Services/ProjectionThreadActivities.ts";
import * as ProjectionThreadMessages from "../persistence/Services/ProjectionThreadMessages.ts";
import * as ProjectionTurns from "../persistence/Services/ProjectionTurns.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { makeAgentsCapability } from "./capabilities/AgentsCapability.ts";
import { makeDatabaseCapability } from "./capabilities/DatabaseCapability.ts";
import { makeEnvironmentsReadCapability } from "./capabilities/EnvironmentsReadCapability.ts";
import { makeHttpCapability } from "./capabilities/HttpCapability.ts";
import { makeProjectionsReadCapability } from "./capabilities/ProjectionsReadCapability.ts";
import { makeSecretsCapability } from "./capabilities/SecretsCapability.ts";
import { makeSourceControlCapability } from "./capabilities/SourceControlCapability.ts";
import { makeTerminalsCapability } from "./capabilities/TerminalsCapability.ts";
import { makeTextGenerationCapability } from "./capabilities/TextGenerationCapability.ts";
import { makeVcsCapability } from "./capabilities/VcsCapability.ts";
import { PluginLockfileStore } from "./PluginLockfileStore.ts";
import { PluginHttpRegistry } from "./PluginHttpRegistry.ts";
import { PluginMigrator } from "./PluginMigrator.ts";
import { PluginModuleLoader } from "./PluginModuleLoader.ts";
import { makePluginLogger } from "./PluginLogger.ts";
import { pluginDataDir, pluginManifestPath, pluginVersionDir } from "./PluginPaths.ts";
import { PluginRuntimeRegistry } from "./PluginRuntimeRegistry.ts";

const APP_VERSION = packageJson.version;
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginManifest));

const healthyActivationDelay = () => {
  const overrideMs = Number.parseInt(process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS ?? "", 10);
  return Number.isFinite(overrideMs) && overrideMs >= 0
    ? Duration.millis(overrideMs)
    : Duration.seconds(30);
};

export class PluginRegistrationError extends Schema.TaggedErrorClass<PluginRegistrationError>()(
  "PluginRegistrationError",
  { pluginId: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} returned an invalid registration: ${this.detail}`;
  }
}

export class PluginCapabilityUnavailable extends Schema.TaggedErrorClass<PluginCapabilityUnavailable>()(
  "PluginCapabilityUnavailable",
  { capability: Schema.String },
) {
  override get message(): string {
    return `Capability ${this.capability} is not available in this host build.`;
  }
}

export class PluginHost extends Context.Service<
  PluginHost,
  {
    readonly start: Effect.Effect<void>;
  }
>()("t3/plugins/PluginHost") {}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return typeof value === "object" && value !== null && "then" in value;
}

const resolveRegistration = (
  pluginId: PluginId,
  definition: PluginDefinition,
  hostApi: PluginHostApi,
) =>
  Effect.suspend(() => {
    const value = definition.register(hostApi);
    if (Effect.isEffect(value)) return value;
    if (isPromiseLike(value)) return Effect.promise(() => value as Promise<PluginRegistration>);
    return Effect.succeed(value);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.fail(
        new PluginRegistrationError({
          pluginId,
          detail: Cause.pretty(cause),
        }),
      ),
    ),
  );

function validateRegistration(
  pluginId: PluginId,
  registration: PluginRegistration,
): Effect.Effect<void, PluginRegistrationError> {
  const methods = new Set<string>();
  for (const rpc of registration.rpc ?? []) {
    if (rpc.scope !== "read" && rpc.scope !== "operate") {
      return Effect.fail(
        new PluginRegistrationError({ pluginId, detail: `invalid RPC scope ${rpc.scope}` }),
      );
    }
    if (methods.has(rpc.method)) {
      return Effect.fail(
        new PluginRegistrationError({ pluginId, detail: `duplicate RPC method ${rpc.method}` }),
      );
    }
    methods.add(rpc.method);
  }
  return Effect.void;
}

const unavailable = (capability: string) =>
  Effect.die(new PluginCapabilityUnavailable({ capability }));

const makeHostApi = (input: {
  readonly pluginId: PluginId;
  readonly capabilities: ReadonlyArray<PluginManifest["capabilities"][number]>;
  readonly dataDir: string;
  readonly logger: PluginLogger;
  readonly deps: {
    readonly sql: SqlClient.SqlClient;
    readonly secretStore: ServerSecretStore.ServerSecretStore["Service"];
    readonly config: ServerConfig.ServerConfig["Service"];
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly environment: ServerEnvironment.ServerEnvironment["Service"];
    readonly orchestrationEngine: OrchestrationEngine.OrchestrationEngineService["Service"];
    readonly snapshots: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
    readonly turns: ProjectionTurns.ProjectionTurnRepository["Service"];
    readonly messages: ProjectionThreadMessages.ProjectionThreadMessageRepository["Service"];
    readonly activities: ProjectionThreadActivities.ProjectionThreadActivityRepository["Service"];
    readonly providerInstances: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"];
    readonly git: GitVcsDriver.GitVcsDriver["Service"];
    readonly checkpointStore: CheckpointStore.CheckpointStore["Service"];
    readonly textGeneration: TextGeneration.TextGeneration["Service"];
    readonly sourceControlRegistry: SourceControlProviderRegistry.SourceControlProviderRegistry["Service"];
    readonly github: GitHubCli.GitHubCli["Service"];
    readonly terminals: TerminalManager.TerminalManager["Service"];
  };
}): { readonly api: PluginHostApi; readonly teardown: ReadonlyArray<Effect.Effect<void>> } => {
  const capabilities = new Set(input.capabilities);
  const available = <A>(capability: PluginManifest["capabilities"][number], value: A) =>
    capabilities.has(capability) ? Effect.succeed(value) : unavailable(capability);

  const terminalsBundle = makeTerminalsCapability({
    pluginId: input.pluginId,
    manager: input.deps.terminals,
  });
  const teardown: Array<Effect.Effect<void>> = [];
  if (capabilities.has("terminals")) {
    teardown.push(terminalsBundle.shutdown);
  }

  const api: PluginHostApi = {
    hostApiVersion: HOST_API_VERSION,
    config: {
      appVersion: APP_VERSION,
      hostApiVersion: HOST_API_VERSION,
      dataDir: input.dataDir,
      logger: input.logger,
    },
    agents: available(
      "agents",
      makeAgentsCapability({
        pluginId: input.pluginId,
        engine: input.deps.orchestrationEngine,
        snapshots: input.deps.snapshots,
        turns: input.deps.turns,
        messages: input.deps.messages,
        providerInstances: input.deps.providerInstances,
      }),
    ),
    vcs: available(
      "vcs",
      makeVcsCapability({
        git: input.deps.git,
        checkpoints: input.deps.checkpointStore,
      }),
    ),
    terminals: available("terminals", terminalsBundle.capability),
    database: available("database", makeDatabaseCapability(input.deps.sql)),
    projectionsRead: available(
      "projections.read",
      makeProjectionsReadCapability({
        snapshots: input.deps.snapshots,
        turns: input.deps.turns,
        messages: input.deps.messages,
        activities: input.deps.activities,
      }),
    ),
    environmentsRead: available(
      "environments.read",
      makeEnvironmentsReadCapability({
        environment: input.deps.environment,
        snapshots: input.deps.snapshots,
      }),
    ),
    secrets: available(
      "secrets",
      makeSecretsCapability({
        pluginId: input.pluginId,
        store: input.deps.secretStore,
        config: input.deps.config,
        fileSystem: input.deps.fileSystem,
        path: input.deps.path,
      }),
    ),
    http: available("http", makeHttpCapability(input.pluginId)),
    sourceControl: available(
      "sourceControl",
      makeSourceControlCapability({
        registry: input.deps.sourceControlRegistry,
        github: input.deps.github,
      }),
    ),
    textGeneration: available(
      "textGeneration",
      makeTextGenerationCapability(input.deps.textGeneration),
    ),
  };

  return { api, teardown };
};

const upgradeLockfileEntry = (
  entry: PluginLockfilePlugin,
  staged: NonNullable<PluginLockfilePlugin["staged"]>,
): PluginLockfilePlugin => ({
  version: staged.version,
  sha256: staged.sha256,
  sourceId: entry.sourceId,
  enabled: entry.enabled,
  state: "active",
  activation: entry.activation,
  installedAt: entry.installedAt,
  lastError: entry.lastError,
});

const getLockfilePlugin = (lockfile: PluginLockfile, pluginId: PluginId) =>
  (lockfile.plugins as Readonly<Record<string, PluginLockfilePlugin | undefined>>)[pluginId];

const updateFailure = (
  store: PluginLockfileStore["Service"],
  pluginId: PluginId,
  message: string,
) =>
  store.updatePlugin(pluginId, ({ current }) =>
    Effect.succeed(
      current
        ? {
            ...current,
            state: "failed",
            lastError: message,
            activation: {
              ...current.activation,
              activatingSince: null,
            },
          }
        : undefined,
    ),
  );

const startService = (input: {
  readonly pluginId: PluginId;
  readonly logger: PluginLogger;
  readonly service: PluginServiceDescriptor;
}) =>
  input.service.run({ pluginId: input.pluginId, logger: input.logger }).pipe(
    Effect.catchCause((cause) =>
      input.logger.error("plugin service failed; restarting", {
        service: input.service.name,
        cause: Cause.pretty(cause),
      }),
    ),
    // Exponential backoff capped at 30s so a flapping service keeps
    // retrying at a bounded cadence instead of backing off forever.
    Effect.repeat(
      Schedule.either(Schedule.exponential("250 millis"), Schedule.spaced("30 seconds")),
    ),
  );

export const make = Effect.fn("PluginHost.make")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* PluginLockfileStore;
  const loader = yield* PluginModuleLoader;
  const migrator = yield* PluginMigrator;
  const registry = yield* PluginRuntimeRegistry;
  const httpRegistry = yield* PluginHttpRegistry;
  const clock = yield* Clock.Clock;
  const sql = yield* SqlClient.SqlClient;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const turns = yield* ProjectionTurns.ProjectionTurnRepository;
  const messages = yield* ProjectionThreadMessages.ProjectionThreadMessageRepository;
  const activities = yield* ProjectionThreadActivities.ProjectionThreadActivityRepository;
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const sourceControlRegistry = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const github = yield* GitHubCli.GitHubCli;
  const terminals = yield* TerminalManager.TerminalManager;
  const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;

  const publishPluginStateChanged = (pluginId: PluginId, state: PluginState) =>
    lifecycleEvents
      .publish({
        version: 1,
        type: "plugins",
        payload: {
          kind: "plugin-state-changed",
          pluginId,
          state,
        },
      })
      .pipe(Effect.ignoreCause({ log: true }), Effect.asVoid);

  const markFailure = (pluginId: PluginId, message: string) =>
    updateFailure(store, pluginId, message).pipe(
      Effect.tap(() => publishPluginStateChanged(pluginId, "failed")),
    );

  const readManifest = (pluginDir: string) =>
    fs
      .readFileString(pluginManifestPath(pluginDir, path.join))
      .pipe(Effect.flatMap(decodeManifest));

  const loadPlugin = (pluginId: PluginId, entry: PluginLockfilePlugin) =>
    Effect.gen(function* () {
      const pluginDir = pluginVersionDir(config.pluginsDir, pluginId, entry.version, path.join);
      const manifest = yield* readManifest(pluginDir);
      if (manifest.id !== pluginId) {
        return yield* new PluginRegistrationError({
          pluginId,
          detail: `manifest id ${manifest.id} does not match lockfile id`,
        });
      }
      if (!hostApiSatisfies(manifest.hostApi, HOST_API_VERSION)) {
        yield* store
          .updatePlugin(pluginId, ({ current }) =>
            Effect.succeed(current ? { ...current, state: "disabled-by-host" } : undefined),
          )
          .pipe(Effect.tap(() => publishPluginStateChanged(pluginId, "disabled-by-host")));
        yield* Effect.logWarning("Plugin disabled by host API version mismatch", {
          pluginId,
          requested: manifest.hostApi,
          hostApiVersion: HOST_API_VERSION,
        });
        return;
      }
      if (!manifest.entries.server) {
        yield* Effect.logDebug("Skipping web-only plugin in server plugin host", { pluginId });
        return;
      }

      const serverEntry = manifest.entries.server;
      const serverEntryPath = path.join(pluginDir, serverEntry);
      if (!(yield* fs.exists(pluginDir)) || !(yield* fs.exists(serverEntryPath))) {
        yield* markFailure(pluginId, "plugin directory or server entry is missing");
        return;
      }

      const activatingSince = DateTime.formatIso(yield* DateTime.now);
      yield* store.updatePlugin(pluginId, ({ current }) =>
        Effect.succeed(
          current
            ? {
                ...current,
                activation: {
                  ...current.activation,
                  activatingSince,
                },
              }
            : undefined,
        ),
      );

      const scope = yield* Scope.make("sequential");
      const readiness = yield* Deferred.make<void>();
      const logger = makePluginLogger(pluginId);
      const dataDir = pluginDataDir(config.pluginsDir, pluginId, path.join);
      const { api: hostApi, teardown: hostApiTeardown } = makeHostApi({
        pluginId,
        capabilities: manifest.capabilities,
        dataDir,
        logger,
        deps: {
          sql,
          secretStore,
          config,
          fileSystem: fs,
          path,
          environment,
          orchestrationEngine,
          snapshots,
          turns,
          messages,
          activities,
          providerInstances,
          git,
          checkpointStore,
          textGeneration,
          sourceControlRegistry,
          github,
          terminals,
        },
      });

      const activation = Effect.gen(function* () {
        // Register capability teardowns (e.g. killing leaked terminals) on the
        // plugin scope before running any plugin code, so cleanup fires on
        // EVERY exit path — activation failure, stop, disable, crash.
        for (const teardown of hostApiTeardown) {
          yield* Scope.addFinalizer(scope, teardown);
        }
        yield* fs.makeDirectory(dataDir, { recursive: true });
        const definition = yield* loader.loadServerEntry(pluginDir, serverEntry);
        const registration = yield* resolveRegistration(pluginId, definition, hostApi);
        yield* validateRegistration(pluginId, registration);
        yield* migrator.run(pluginId, registration.migrations ?? []);
        if (registration.recover) {
          yield* registration.recover();
        }
        if (manifest.capabilities.includes("http") && (registration.http?.length ?? 0) > 0) {
          yield* httpRegistry.put(pluginId, registration.http ?? []);
          yield* Scope.addFinalizer(scope, httpRegistry.remove(pluginId));
        }
        yield* registry.put(pluginId, { manifest, registration, readiness, scope });
        for (const service of registration.services ?? []) {
          yield* startService({ pluginId, logger, service }).pipe(
            Effect.forkScoped,
            Scope.provide(scope),
          );
        }
        yield* Deferred.succeed(readiness, undefined).pipe(Effect.orDie);
        const clearHealthyActivation = store.updatePlugin(pluginId, ({ current }) =>
          Effect.succeed(
            current
              ? {
                  ...current,
                  activation: { activatingSince: null, crashCount: 0 },
                  lastError: null,
                }
              : undefined,
          ),
        );
        const healthyDelay = healthyActivationDelay();
        if (Duration.toMillis(healthyDelay) === 0) {
          yield* clearHealthyActivation;
        } else {
          yield* clock.sleep(healthyDelay).pipe(
            Effect.flatMap(() => clearHealthyActivation),
            Effect.ignoreCause({ log: true }),
            Effect.forkScoped,
            Scope.provide(scope),
          );
        }
      });

      const exit = yield* activation.pipe(Scope.provide(scope), Effect.exit);
      if (Exit.isFailure(exit)) {
        yield* Scope.close(scope, exit);
        const message = Cause.pretty(exit.cause);
        yield* markFailure(pluginId, message);
        yield* Effect.logWarning("Plugin activation failed", { pluginId, cause: message });
      } else {
        yield* publishPluginStateChanged(pluginId, "active");
      }
    });

  const reconcilePendingState = (pluginId: PluginId, entry: PluginLockfilePlugin) =>
    Effect.gen(function* () {
      if (entry.state === "pending-remove") {
        yield* fs.remove(path.join(config.pluginsDir, pluginId), { recursive: true, force: true });
        yield* store.removePlugin(pluginId);
        return false;
      }
      if (entry.state === "pending-upgrade") {
        if (!entry.staged) {
          yield* markFailure(pluginId, "pending upgrade is missing staged plugin metadata");
          return false;
        }
        const staged = entry.staged;
        yield* store
          .updatePlugin(pluginId, ({ current }) =>
            Effect.succeed(current ? upgradeLockfileEntry(current, staged) : undefined),
          )
          .pipe(Effect.tap(() => publishPluginStateChanged(pluginId, "active")));
        return true;
      }
      if (entry.activation.activatingSince !== null) {
        const crashCount = entry.activation.crashCount + 1;
        if (crashCount >= 2) {
          yield* store
            .updatePlugin(pluginId, ({ current }) =>
              Effect.succeed(
                current
                  ? {
                      ...current,
                      state: "failed",
                      lastError: "disabled after repeated crashes",
                      activation: { activatingSince: null, crashCount },
                    }
                  : undefined,
              ),
            )
            .pipe(Effect.tap(() => publishPluginStateChanged(pluginId, "failed")));
          return false;
        }
        yield* store.updatePlugin(pluginId, ({ current }) =>
          Effect.succeed(
            current
              ? {
                  ...current,
                  activation: { activatingSince: null, crashCount },
                }
              : undefined,
          ),
        );
      }
      return true;
    });

  const start = Effect.gen(function* () {
    if (process.env.T3_NO_PLUGINS === "1") {
      yield* Effect.logInfo("Plugin host disabled by T3_NO_PLUGINS");
      return;
    }
    if (!(yield* fs.exists(store.lockfilePath).pipe(Effect.orElseSucceed(() => false)))) {
      return;
    }
    yield* loader.ensureHostSingletonResolution;
    const lockfile = yield* store.readLockfile.pipe(
      Effect.catch((error) =>
        Effect.logWarning("Plugin host could not read lockfile", {
          path: store.lockfilePath,
          error: error.message,
        }).pipe(Effect.as({ plugins: {}, sources: [] })),
      ),
    );

    for (const [rawPluginId, entry] of Object.entries(lockfile.plugins)) {
      const pluginId = rawPluginId as PluginId;
      const shouldContinue = yield* reconcilePendingState(pluginId, entry).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Plugin pending-state reconciliation failed", {
            pluginId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(false)),
        ),
      );
      if (!shouldContinue || !entry.enabled) continue;
      const currentLockfile = yield* store.readLockfile.pipe(Effect.orElseSucceed(() => lockfile));
      const currentEntry = getLockfilePlugin(currentLockfile, pluginId);
      if (!currentEntry?.enabled || currentEntry.state !== "active") continue;
      yield* loadPlugin(pluginId, currentEntry).pipe(
        Effect.catchCause((cause) =>
          markFailure(pluginId, Cause.pretty(cause)).pipe(
            Effect.andThen(
              Effect.logWarning("Plugin activation failed before scope acquisition", {
                pluginId,
                cause: Cause.pretty(cause),
              }),
            ),
            Effect.ignore,
          ),
        ),
      );
    }
  }).pipe(Effect.ignoreCause({ log: true }));

  return PluginHost.of({ start });
});

export const layer = Layer.effect(PluginHost, make());
