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
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";
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
import { makeFilesystemCapability } from "./capabilities/FilesystemCapability.ts";
import { makeHttpCapability } from "./capabilities/HttpCapability.ts";
import {
  makeHttpClientCapability,
  PluginHttpClientTransportService,
} from "./capabilities/HttpClientCapability.ts";
import { makeProjectionsReadCapability } from "./capabilities/ProjectionsReadCapability.ts";
import { makeSecretsCapability } from "./capabilities/SecretsCapability.ts";
import { makeSourceControlCapability } from "./capabilities/SourceControlCapability.ts";
import { makeTerminalsCapability } from "./capabilities/TerminalsCapability.ts";
import { makeTextGenerationCapability } from "./capabilities/TextGenerationCapability.ts";
import { makeVcsCapability } from "./capabilities/VcsCapability.ts";
import { OutboundUrlLookup } from "./OutboundUrlValidator.ts";
import {
  PluginLockfileStore,
  type PluginLockfileCorruptError,
  type PluginLockfileReadError,
} from "./PluginLockfileStore.ts";
import { PluginHttpRegistry } from "./PluginHttpRegistry.ts";
import { PluginMigrator } from "./PluginMigrator.ts";
import { PluginModuleLoader } from "./PluginModuleLoader.ts";
import { makePluginLogger } from "./PluginLogger.ts";
import { pluginDataDir, pluginManifestPath, pluginVersionDir } from "./PluginPaths.ts";
import { PluginRuntimeRegistry } from "./PluginRuntimeRegistry.ts";
import { PluginToolCatalog, PluginToolCatalogError } from "./PluginToolCatalog.ts";
import { makePluginWorkspaceGrants, type PluginWorkspaceGrants } from "./PluginWorkspaceGrants.ts";

const APP_VERSION = packageJson.version;
const PRESERVE_DATA_MARKER = ".preserve-data-on-remove";
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginManifest));

const healthyActivationDelay = () => {
  const overrideMs = Number.parseInt(process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS ?? "", 10);
  return Number.isFinite(overrideMs) && overrideMs >= 0
    ? Duration.millis(overrideMs)
    : Duration.seconds(30);
};

// Bound plugin-controlled register()/recover() so an unresponsive plugin fails
// activation via the normal failure path instead of stalling the host: a hung
// register()/recover() would otherwise block server startup or an
// install/enable request indefinitely.
const registrationTimeout = () => {
  const overrideMs = Number.parseInt(process.env.T3_PLUGIN_HOST_REGISTER_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(overrideMs) && overrideMs > 0
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

// Internal control-flow sentinel: raised when an activation is intentionally
// cancelled by a concurrent lifecycle change (see the pre-put state re-check in
// loadPlugin). It is deliberately NOT part of the plugin SDK/contract surface —
// it only travels inside the host's failure channel so a self-cancel can be
// told apart from a genuine fiber interruption (host shutdown) and from a real
// activation error.
export class PluginActivationCanceled extends Schema.TaggedErrorClass<PluginActivationCanceled>()(
  "PluginActivationCanceled",
  { pluginId: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} activation was canceled: ${this.reason}`;
  }
}

// True ONLY when a cause is composed EXCLUSIVELY of the activation-cancel
// sentinel (at least one reason, and EVERY reason is the sentinel). Scope.close
// can produce a MIXED cause that combines the sentinel with a finalizer/teardown
// error/defect or a fiber interrupt; a "contains" check would fold those benign-
// looking mixed causes into the cancel branch and silently drop a real teardown
// failure or swallow a shutdown interrupt. Requiring "only" keeps a mixed cause
// out of the cancel branch. Iterating cause.reasons and narrowing with
// isFailReason is the idiomatic effect-4 way to inspect a cause for a specific
// tagged error; Schema.is is the schema-aware runtime check for the value.
// Exported for unit testing over hand-built causes.
const isActivationCanceled = Schema.is(PluginActivationCanceled);
export const causeIsActivationCanceledOnly = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.length > 0 &&
  cause.reasons.every((reason) => Cause.isFailReason(reason) && isActivationCanceled(reason.error));

// True when a cause contains AT LEAST ONE interrupt reason, even when mixed with
// failures or defects. Cause.hasInterrupts is the idiomatic effect-4 "contains
// any interrupt" primitive (as opposed to hasInterruptsOnly, which is true only
// when EVERY reason is an interrupt). Any interrupt component means a host
// shutdown is in flight, so it must win over the sentinel/error branches and
// re-raise. Exported for unit testing over hand-built causes.
export const causeContainsInterrupt = (cause: Cause.Cause<unknown>): boolean =>
  Cause.hasInterrupts(cause);

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
    // A lockfile read/parse failure now propagates (previously swallowed into a
    // silent no-op); callers treat it as an activation failure.
    readonly activatePlugin: (
      pluginId: PluginId,
    ) => Effect.Effect<void, PluginLockfileReadError | PluginLockfileCorruptError>;
    readonly deactivatePlugin: (pluginId: PluginId) => Effect.Effect<void>;
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
      // A clean host shutdown interrupts the activation fiber mid-register();
      // let that interruption propagate instead of persisting a spurious
      // "failed" registration error.
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause as Cause.Cause<never>)
        : Effect.fail(
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
  capabilities: ReadonlyArray<PluginManifest["capabilities"][number]>,
): Effect.Effect<void, PluginRegistrationError> {
  // Plugin modules are dynamically loaded JS, so the SDK's `"read" | "operate"`
  // scope type is NOT enforced at runtime. Validate rpc AND streams identically
  // here: an out-of-whitelist scope (e.g. a typo/casing like "Operate") must be
  // rejected at registration rather than silently fall through to the weaker
  // read requirement in the dispatcher.
  const rpcMethods = new Set<string>();
  for (const rpc of registration.rpc ?? []) {
    if (rpc.scope !== "read" && rpc.scope !== "operate") {
      return Effect.fail(
        new PluginRegistrationError({ pluginId, detail: `invalid RPC scope ${rpc.scope}` }),
      );
    }
    if (rpcMethods.has(rpc.method)) {
      return Effect.fail(
        new PluginRegistrationError({ pluginId, detail: `duplicate RPC method ${rpc.method}` }),
      );
    }
    rpcMethods.add(rpc.method);
  }
  const streamMethods = new Set<string>();
  for (const stream of registration.streams ?? []) {
    if (stream.scope !== "read" && stream.scope !== "operate") {
      return Effect.fail(
        new PluginRegistrationError({ pluginId, detail: `invalid stream scope ${stream.scope}` }),
      );
    }
    if (streamMethods.has(stream.method)) {
      return Effect.fail(
        new PluginRegistrationError({
          pluginId,
          detail: `duplicate stream method ${stream.method}`,
        }),
      );
    }
    streamMethods.add(stream.method);
  }
  // Tools require the dedicated "tools" capability (capability-level consent).
  // Full descriptor validation + fingerprint reserve happen via PluginToolCatalog
  // before any irreversible McpServer.addTool.
  if ((registration.tools?.length ?? 0) > 0 && !capabilities.includes("tools")) {
    return Effect.fail(
      new PluginRegistrationError({
        pluginId,
        detail: 'plugin declares tools but does not include the "tools" capability',
      }),
    );
  }
  return Effect.void;
}

const unavailable = (capability: string) =>
  // Typed failure (not a defect) so a plugin that calls an undeclared capability
  // can catch/degrade gracefully instead of crashing the call as a defect.
  Effect.fail(new PluginCapabilityUnavailable({ capability }));

const makeHostApi = (input: {
  readonly pluginId: PluginId;
  readonly capabilities: ReadonlyArray<PluginManifest["capabilities"][number]>;
  readonly dataDir: string;
  readonly logger: PluginLogger;
  readonly grants: PluginWorkspaceGrants;
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
    readonly outboundLookup: OutboundUrlLookup["Service"];
    readonly httpClientTransport: PluginHttpClientTransportService["Service"];
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
        snapshots: input.deps.snapshots,
        grants: input.grants,
        fileSystem: input.deps.fileSystem,
        path: input.deps.path,
        worktreesDir: input.deps.config.worktreesDir,
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
    filesystem: available(
      "filesystem",
      makeFilesystemCapability({
        snapshots: input.deps.snapshots,
        grants: input.grants,
      }),
    ),
    httpClient: available(
      "httpClient",
      makeHttpClientCapability({
        lookup: input.deps.outboundLookup,
        transport: input.deps.httpClientTransport,
      }),
    ),
    sourceControl: available(
      "sourceControl",
      makeSourceControlCapability({
        registry: input.deps.sourceControlRegistry,
        github: input.deps.github,
        snapshots: input.deps.snapshots,
        grants: input.grants,
        fileSystem: input.deps.fileSystem,
        path: input.deps.path,
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
  // Reset activation health for the new build. Carrying over the old version's
  // crashCount could immediately trip the repeated-crash safe mode on the first
  // startup of the upgrade, and its lastError would surface a stale failure the
  // new version never produced. activatingSince starts null; loadPlugin sets it
  // when the fresh activation begins.
  activation: { activatingSince: null, crashCount: 0 },
  installedAt: entry.installedAt,
  lastError: null,
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
            // Only an in-flight activation ("active") should flip to "failed".
            // If the user concurrently disabled/uninstalled/upgraded the plugin
            // while it was activating, preserve that requested lifecycle state
            // rather than clobbering it with "failed".
            state: current.state === "active" ? "failed" : current.state,
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
  const toolCatalog = yield* PluginToolCatalog;
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
  const outboundLookup = yield* OutboundUrlLookup;
  const httpClientTransport = yield* PluginHttpClientTransportService;
  const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;

  // Per-pluginId single-flight for activation/deactivation. Two concurrent
  // activatePlugin(pluginId) calls would otherwise both observe an empty registry
  // and both run loadPlugin; the second registry.put overwrites the first runtime's
  // entry, orphaning its scope — the first runtime's forked services,
  // terminal-cleanup finalizers, and HTTP routes stay live but unreachable, and a
  // later deactivatePlugin only tears down the second. A per-plugin single-permit
  // semaphore, get-or-created atomically under a synchronized ref, serializes them
  // so the second caller's registry.get double-check short-circuits instead of
  // loading a second runtime.
  const activationLocks = yield* SynchronizedRef.make(
    HashMap.empty<PluginId, Semaphore.Semaphore>(),
  );
  const withPluginActivationLock = <A, E, R>(
    pluginId: PluginId,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    SynchronizedRef.modifyEffect(activationLocks, (locks) => {
      const existing = HashMap.get(locks, pluginId);
      return Option.isSome(existing)
        ? Effect.succeed([existing.value, locks] as const)
        : Semaphore.make(1).pipe(
            Effect.map(
              (semaphore) => [semaphore, HashMap.set(locks, pluginId, semaphore)] as const,
            ),
          );
    }).pipe(Effect.flatMap((semaphore) => semaphore.withPermits(1)(effect)));

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
      // Publish the state that was actually persisted: updateFailure preserves a
      // concurrently-requested lifecycle state (disabled/pending-remove/...)
      // instead of forcing "failed", so announce that rather than a stale
      // "failed".
      Effect.flatMap((lockfile) => {
        const state = getLockfilePlugin(lockfile, pluginId)?.state;
        return state === undefined ? Effect.void : publishPluginStateChanged(pluginId, state);
      }),
    );

  // Clear ONLY the in-flight activation marker, preserving state/crashCount/
  // lastError. Used after a clean interrupt/cancel teardown so reconcile on the
  // next start does not mistake the intentional cancellation for a crash (a
  // lingering activatingSince bumps crashCount and eventually forces "failed").
  const clearActivatingMarker = (pluginId: PluginId) =>
    store
      .updatePlugin(pluginId, ({ current }) =>
        Effect.succeed(
          current
            ? { ...current, activation: { ...current.activation, activatingSince: null } }
            : undefined,
        ),
      )
      .pipe(Effect.ignore);

  // Outer handler for a loadPlugin failure that escaped the activation-exit
  // block (setup errors, or a re-raised interrupt/cancel from that block).
  // Three dispositions, checked in order:
  //   - contains ANY interrupt (clean shutdown / scope close, even when mixed
  //     with the sentinel or a teardown error): re-raise the whole cause so it
  //     keeps propagating and the host stops promptly.
  //   - EXCLUSIVELY the activation-cancel sentinel (concurrent disable/uninstall
  //     aborted the activation): benign — the teardown already ran and the marker
  //     was cleared, so just log and swallow, leaving the persisted state intact.
  //   - anything else (a genuine error, INCLUDING the sentinel combined with a
  //     real teardown/finalizer error): persist "failed" and log.
  const handleLoadFailureCause = (
    pluginId: PluginId,
    logMessage: string,
    cause: Cause.Cause<unknown>,
  ) =>
    causeContainsInterrupt(cause)
      ? Effect.failCause(cause as Cause.Cause<never>)
      : causeIsActivationCanceledOnly(cause)
        ? Effect.logWarning("Plugin activation canceled", {
            pluginId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.ignore)
        : markFailure(pluginId, Cause.pretty(cause)).pipe(
            Effect.andThen(Effect.logWarning(logMessage, { pluginId, cause: Cause.pretty(cause) })),
            Effect.ignore,
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
      // The plugin is loaded from the lockfile version's directory, so a manifest
      // whose version disagrees with the lockfile entry means the staged bytes do
      // not match the recorded install: runtime/catalog state would report a
      // different version than the lockfile/upgrade state, and migrations (keyed
      // only by plugin id) would run against ambiguous provenance. Reject it.
      if (manifest.version !== entry.version) {
        return yield* new PluginRegistrationError({
          pluginId,
          detail: `manifest version ${manifest.version} does not match lockfile version ${entry.version}`,
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
      const grants = yield* makePluginWorkspaceGrants;
      const { api: hostApi, teardown: hostApiTeardown } = makeHostApi({
        pluginId,
        capabilities: manifest.capabilities,
        dataDir,
        logger,
        grants,
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
          outboundLookup,
          httpClientTransport,
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
        const registration = yield* resolveRegistration(pluginId, definition, hostApi).pipe(
          Effect.timeout(registrationTimeout()),
        );
        yield* validateRegistration(pluginId, registration, manifest.capabilities);
        // Always reserve (including empty tool sets) so descriptor-set removals
        // are rejected as restart-required before registry.put. Ownership/
        // fingerprint checks run before any irreversible MCP addTool.
        yield* toolCatalog
          .reserve(pluginId, registration.tools, {
            hasToolsCapability: manifest.capabilities.includes("tools"),
          })
          .pipe(
            Effect.mapError(
              (error: PluginToolCatalogError) =>
                new PluginRegistrationError({ pluginId, detail: error.detail }),
            ),
          );
        yield* migrator.run(pluginId, registration.migrations ?? []);
        if (registration.recover) {
          yield* registration.recover().pipe(Effect.timeout(registrationTimeout()));
        }
        if (manifest.capabilities.includes("http") && (registration.http?.length ?? 0) > 0) {
          yield* httpRegistry.put(pluginId, registration.http ?? []);
          yield* Scope.addFinalizer(scope, httpRegistry.remove(pluginId));
        }
        // Re-check lifecycle state right before publishing the runtime. A
        // concurrent disable/uninstall flips the lockfile and runs
        // deactivatePlugin, which finds no runtime yet (we have not put it) and
        // returns early. Without this guard activation would finish and the
        // now-disabled/pending-remove plugin's runtime + services + HTTP routes
        // would go live anyway. Abort via the typed cancel sentinel (NOT a fiber
        // interrupt) so the failure branch closes the scope (removing any partial
        // HTTP registration), skips the registry.put + "active" publish, clears
        // the activating marker, and leaves the persisted state intact — while
        // staying distinguishable from a genuine host-shutdown interruption.
        const stateBeforePut = yield* store.readLockfile.pipe(
          Effect.map((current) => getLockfilePlugin(current, pluginId)?.state),
          Effect.orElseSucceed(() => undefined as PluginState | undefined),
        );
        if (stateBeforePut !== "active") {
          return yield* new PluginActivationCanceled({
            pluginId,
            reason: `lifecycle state changed to ${stateBeforePut ?? "missing"} during activation`,
          });
        }
        yield* registry.put(pluginId, { manifest, registration, readiness, scope });
        // Re-check AFTER put. Disable can flip the lockfile and catalog.deactivate
        // while we hold the activation lock (deactivate waits on this lock after its
        // early deactivate). registry.put notifies PluginToolsRegistration, which
        // may catalog.activate — reopening both gates — before disable acquires the
        // lock. If lifecycle is no longer active, undo the put immediately under the
        // lock so a late activate cannot leave tools callable.
        const stateAfterPut = yield* store.readLockfile.pipe(
          Effect.map((current) => getLockfilePlugin(current, pluginId)?.state),
          Effect.orElseSucceed(() => undefined as PluginState | undefined),
        );
        if (stateAfterPut !== "active") {
          yield* registry.remove(pluginId);
          yield* toolCatalog.deactivate(pluginId);
          return yield* new PluginActivationCanceled({
            pluginId,
            reason: `lifecycle state changed to ${stateAfterPut ?? "missing"} during activation`,
          });
        }
        for (const service of registration.services ?? []) {
          yield* startService({ pluginId, logger, service }).pipe(
            Effect.forkScoped,
            Scope.provide(scope),
          );
        }
        yield* Deferred.succeed(readiness, undefined).pipe(Effect.orDie);
        // Clear activatingSince immediately on successful activation. Activation
        // has COMPLETED, so the plugin is no longer "activating"; leaving the
        // marker set until the delayed healthy-clear fires would make an
        // unrelated process restart within the stability window look like an
        // interrupted activation, wrongly incrementing crashCount and eventually
        // failing a healthy plugin. crashCount is still only forgiven (reset to
        // 0) after the stability window, so genuine activation-time crash loops
        // keep accumulating across restarts.
        const markActivated = (forgiveCrashes: boolean) =>
          store.updatePlugin(pluginId, ({ current }) =>
            Effect.succeed(
              current
                ? {
                    ...current,
                    activation: {
                      activatingSince: null,
                      crashCount: forgiveCrashes ? 0 : current.activation.crashCount,
                    },
                    lastError: null,
                  }
                : undefined,
            ),
          );
        yield* markActivated(false);
        const healthyDelay = healthyActivationDelay();
        if (Duration.toMillis(healthyDelay) === 0) {
          yield* markActivated(true);
        } else {
          yield* clock.sleep(healthyDelay).pipe(
            Effect.flatMap(() => markActivated(true)),
            Effect.ignoreCause({ log: true }),
            Effect.forkScoped,
            Scope.provide(scope),
          );
        }
      });

      // effect@4.0.0-beta.78's `exitFailCause` evaluator skips EVERY `contE`
      // continuation while an EXTERNAL fiber interrupt is pending and the fiber is
      // interruptible (internal/core.ts: `while (fiber.interruptible &&
      // fiber._interruptedCause && cont)`). `Effect.exit` is a plain contE/contA
      // primitive with no `contAll`, so a real host-shutdown interrupt of a
      // still-interruptible `activation` would unwind straight past this capture:
      // the exit ladder below (Scope.close terminal-teardown + httpRegistry.remove
      // finalizers, registry.remove, clearActivatingMarker) would never run,
      // leaking service fibers/terminals into a never-closed detached scope and
      // stranding `activatingSince` so reconcile phantom-crashes a healthy plugin.
      // (Internal interrupts — Effect.interrupt, Effect.timeout's child — are
      // captured fine, which is all the older tests covered.) Running the capture +
      // ladder inside `uninterruptibleMask` (with `restore` keeping `activation`
      // itself interruptible so shutdown still stops register()/services promptly)
      // makes the teardown fire on external interrupt too, and the interrupt still
      // propagates once the mask is left because it stays pending.
      yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const exit = yield* restore(activation.pipe(Scope.provide(scope))).pipe(Effect.exit);
          if (Exit.isFailure(exit)) {
            yield* Scope.close(scope, exit);
            // Activation may have already inserted the runtime into the registry
            // (registry.put runs mid-activation, before later steps). On failure the
            // scope is now closed, so drop the stale entry — otherwise registry.get
            // and registry.list keep reporting the plugin as active with a dead
            // scope and an unresolved readiness Deferred.
            yield* registry.remove(pluginId).pipe(Effect.ignore);
            yield* toolCatalog.deactivate(pluginId).pipe(Effect.ignore);
            if (causeContainsInterrupt(exit.cause)) {
              // ANY interruption (a clean host shutdown / scope close / stop), even
              // when mixed with the cancel sentinel or a teardown error. The teardown
              // above already ran, so this is NOT a crash — clear the activating
              // marker so reconcile on the next start does not miscount it, then
              // re-raise the whole cause so the persisted lifecycle state stays intact
              // and the host stops promptly.
              yield* clearActivatingMarker(pluginId);
              return yield* Effect.failCause(exit.cause as Cause.Cause<never>);
            }
            if (causeIsActivationCanceledOnly(exit.cause)) {
              // EXCLUSIVELY the cancel sentinel: a concurrent disable/uninstall
              // cancelled this activation via the pre-put re-check. The teardown above
              // already ran (not a crash) — clear the activating marker and re-raise
              // the typed sentinel so callers can tell it apart from a genuine error
              // (do NOT mark "failed") and from a shutdown interrupt (handled above).
              yield* clearActivatingMarker(pluginId);
              return yield* Effect.failCause(exit.cause as Cause.Cause<never>);
            }
            // Genuine error — INCLUDING the sentinel combined with a real teardown/
            // finalizer error/defect. Do NOT drop it: persist "failed".
            const message = Cause.pretty(exit.cause);
            yield* markFailure(pluginId, message);
            yield* Effect.logWarning("Plugin activation failed", { pluginId, cause: message });
            return;
          }
          // Announce the state actually persisted, not a hardcoded "active", so a
          // concurrent disable/uninstall (which flips the lockfile and runs
          // deactivatePlugin after registry.put but before this publish) isn't
          // contradicted.
          const persistedState = yield* store.readLockfile.pipe(
            Effect.map((lockfile) => getLockfilePlugin(lockfile, pluginId)?.state ?? "active"),
            Effect.orElseSucceed(() => "active" as PluginState),
          );
          yield* publishPluginStateChanged(pluginId, persistedState);
        }),
      );
    });

  const activatePlugin: PluginHost["Service"]["activatePlugin"] = (pluginId) =>
    Effect.gen(function* () {
      if (process.env.T3_NO_PLUGINS === "1") {
        yield* Effect.logInfo("Plugin host disabled by T3_NO_PLUGINS", { pluginId });
        return;
      }
      // Single-flight per pluginId (see activationLocks): a second concurrent
      // activatePlugin waits for the first to finish, then its registry.get
      // double-check returns Some and short-circuits — no second loadPlugin, no
      // leaked runtime. The registry.get early-return stays INSIDE the lock.
      yield* withPluginActivationLock(
        pluginId,
        Effect.gen(function* () {
          const active = yield* registry.get(pluginId);
          if (Option.isSome(active)) return;
          // Propagate a lockfile read/parse failure instead of substituting an empty
          // lockfile: an empty lockfile makes getLockfilePlugin return undefined and
          // the guard below no-op, so activatePlugin would SUCCEED without loading
          // anything and callers (PluginInstaller) would treat a failed
          // install/enable as done. A genuinely MISSING lockfile is already handled
          // inside readLockfile (it returns EMPTY_PLUGIN_LOCKFILE for a null read),
          // so this only surfaces real read/parse errors.
          const lockfile = yield* store.readLockfile;
          const entry = getLockfilePlugin(lockfile, pluginId);
          if (!entry?.enabled || entry.state !== "active") return;
          yield* loader.ensureHostSingletonResolution;
          yield* loadPlugin(pluginId, entry).pipe(
            Effect.catchCause((cause) =>
              handleLoadFailureCause(pluginId, "Plugin hot activation failed", cause),
            ),
          );
        }),
      );
    });

  const deactivatePlugin: PluginHost["Service"]["deactivatePlugin"] = (pluginId) =>
    // Share the per-plugin activation lock so an activate/deactivate pair for one
    // plugin can't interleave (the round-4/5 pre-put re-check + persisted-state
    // publish remain as defense-in-depth). Neither path calls the other while
    // holding the lock, so this cannot deadlock.
    Effect.gen(function* () {
      // Revoke call-time + visibility bindings BEFORE waiting on the activation
      // lock. Disable persists enabled:false first; without this, fresh tools/call
      // would still pass both gates while a concurrent activate holds the lock.
      yield* toolCatalog.deactivate(pluginId);

      yield* withPluginActivationLock(
        pluginId,
        Effect.gen(function* () {
          const runtime = yield* registry.get(pluginId);
          if (Option.isNone(runtime)) return;
          // Drop the runtime so registry.get fails closed, then interrupt
          // invocation fibers owned by the plugin scope (handlers forkIn that
          // scope). Scope.close does not by itself stop work still running only
          // on the MCP request fiber — ownership is required.
          yield* registry.remove(pluginId);
          yield* toolCatalog.deactivate(pluginId);
          yield* Scope.close(runtime.value.scope, Exit.void).pipe(Effect.ignore);
          yield* httpRegistry.remove(pluginId).pipe(Effect.ignore);
          // Announce the state that is actually persisted rather than a hardcoded
          // "disabled": uninstall sets "pending-remove" then calls this, and
          // publishing "disabled" would contradict the lockfile + list APIs.
          const persistedState = yield* store.readLockfile.pipe(
            Effect.map((lockfile) => getLockfilePlugin(lockfile, pluginId)?.state ?? "disabled"),
            Effect.orElseSucceed(() => "disabled" as PluginState),
          );
          yield* publishPluginStateChanged(pluginId, persistedState);
        }),
      );
    });

  const reconcilePendingState = (pluginId: PluginId, entry: PluginLockfilePlugin) =>
    Effect.gen(function* () {
      if (entry.state === "pending-remove") {
        const pluginRoot = path.join(config.pluginsDir, pluginId);
        const dataDir = pluginDataDir(config.pluginsDir, pluginId, path.join);
        const markerPath = path.join(pluginRoot, PRESERVE_DATA_MARKER);
        const exists = (target: string) =>
          fs.exists(target).pipe(Effect.orElseSucceed(() => false));
        // Deterministic (NOT timestamped) preserve path. A crash between the
        // rename-out and rename-back must be recoverable on the next start; a
        // per-attempt `.preserved-<id>-<millis>` path stranded the data forever
        // because a retry computed a fresh timestamp and never found the old dir.
        const preservedDataDir = path.join(config.pluginsDir, `.preserved-${pluginId}`);
        // A leftover preserved dir is proof a prior reconcile of THIS plugin
        // crashed after moving data aside — adopt it as the preserve intent even
        // if the marker (which lived inside the now-removed root) is already gone.
        const preservedAlready = yield* exists(preservedDataDir);
        const preserveData = preservedAlready || (yield* exists(markerPath));
        if (preserveData) {
          if (!preservedAlready && (yield* exists(dataDir))) {
            yield* fs.rename(dataDir, preservedDataDir);
          }
          yield* fs.remove(pluginRoot, { recursive: true, force: true });
          if (yield* exists(preservedDataDir)) {
            yield* fs.makeDirectory(pluginRoot, { recursive: true });
            yield* fs.rename(preservedDataDir, dataDir);
          }
        } else {
          yield* fs.remove(pluginRoot, { recursive: true, force: true });
        }
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
      // Route the start-loop activation through the SAME per-plugin single-flight
      // lock as activatePlugin, with a registry.get double-check inside it.
      // Commands are accepted before the host finishes starting, and
      // PluginInstaller.setEnabled/confirmInstall call host.activatePlugin on the
      // RPC fiber. Without this lock, an enable/install RPC racing the start loop
      // for the SAME plugin runs two concurrent loadPlugin: register() twice,
      // migrator.run twice (the second INSERT INTO plugin_migrations PK-conflicts →
      // spurious "failed"), and the second registry.put orphans the first runtime's
      // scope. The lock serializes them; the registry.get double-check
      // short-circuits the loser instead of loading a second runtime.
      yield* withPluginActivationLock(
        pluginId,
        Effect.gen(function* () {
          const active = yield* registry.get(pluginId);
          if (Option.isSome(active)) return;
          yield* loadPlugin(pluginId, currentEntry).pipe(
            Effect.catchCause((cause) =>
              // A pure per-plugin self-cancel (the pre-put state re-check firing the
              // typed PluginActivationCanceled sentinel, and ONLY that, for ONE
              // plugin) is benign: log and CONTINUE so the remaining plugins still
              // activate. Everything else goes through handleLoadFailureCause, which
              // RE-RAISES any interrupt-containing cause (host shutdown, even mixed
              // with the sentinel) — that propagates out of this loop so the trailing
              // Effect.ignoreCause ends start promptly instead of plodding through the
              // rest of the plugins during shutdown — and marks a real error
              // (including the sentinel combined with a teardown error) as "failed".
              causeIsActivationCanceledOnly(cause)
                ? Effect.logWarning("Plugin activation canceled during start; skipping", {
                    pluginId,
                    cause: Cause.pretty(cause),
                  })
                : handleLoadFailureCause(
                    pluginId,
                    "Plugin activation failed before scope acquisition",
                    cause,
                  ),
            ),
          );
        }),
      );
    }
  }).pipe(Effect.ignoreCause({ log: true }));

  // Close every active plugin's runtime scope at host teardown. Each activation
  // creates a DETACHED scope (Scope.make in loadPlugin) that nothing else owns,
  // so without this a dev-restart / desktop reload / test teardown leaves the
  // service fibers, terminal-cleanup finalizers, and HTTP-route registrations of
  // still-active plugins leaked in-process. Registered as a layer-scope finalizer
  // (Layer.effect runs make in the layer's build scope), so it fires when the
  // server runtime is torn down. Direct scope close — not deactivatePlugin — to
  // avoid acquiring per-plugin locks or publishing lifecycle events while the
  // whole server is going down.
  yield* Effect.addFinalizer(() =>
    registry.list.pipe(
      Effect.flatMap((runtimes) =>
        Effect.forEach(
          runtimes,
          (runtime) => {
            const pluginId = runtime.manifest.id as PluginId;
            return Scope.close(runtime.scope, Exit.void).pipe(
              Effect.ignore,
              Effect.andThen(httpRegistry.remove(pluginId).pipe(Effect.ignore)),
              Effect.andThen(registry.remove(pluginId)),
            );
          },
          { concurrency: "unbounded", discard: true },
        ),
      ),
      Effect.ignore,
    ),
  );

  return PluginHost.of({ start, activatePlugin, deactivatePlugin });
});

export const layer = Layer.effect(PluginHost, make());
