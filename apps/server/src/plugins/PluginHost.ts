// @effect-diagnostics nodeBuiltinImport:off - plugins load through Node's CommonJS loader, which
// the FileSystem service does not wrap.
import * as NodeModule from "node:module";

import {
  AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  PluginId,
  type PluginListResult,
  type PluginSettingsGetResult,
  type PluginState,
} from "@t3tools/contracts";
import type { PluginDefinition } from "@t3tools/plugin-sdk/server";
import { satisfiesSemverRange } from "@t3tools/shared/semver";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import { authenticateRawRouteWithScope } from "../http.ts";
import { forkParked } from "../serverActivation.ts";
import {
  jsonKilobytes,
  MAX_MESSAGE_KILOBYTES,
  makePluginActivation,
  makePluginApi,
  type PluginActivation,
  type PluginApiServices,
} from "./PluginApi.ts";
import { errorText, PluginCodeError, pluginCodeScope } from "./api/facade.ts";
import { makePluginFailureGuard } from "./pluginFailureGuard.ts";
import { makePluginFailures } from "./pluginFailures.ts";
import { discoverPlugins, type DiscoveredPlugin } from "./pluginDiscovery.ts";
import * as PluginInstaller from "./PluginInstaller.ts";
import * as PluginMcpTools from "./PluginMcpTools.ts";
import { makePluginsConfig, type PluginConfigError } from "./pluginsConfig.ts";
import * as PluginSettingsStore from "./PluginSettingsStore.ts";
import * as PluginStorage from "./PluginStorage.ts";
import { makePluginStates, manifestOf, type PluginRecord } from "./pluginStates.ts";
import { makePluginWebFiles, type PluginWebFile } from "./pluginWebFiles.ts";

// Plugin code that never settles must not keep a plugin loading, a client's call open, or Disable
// and Reload waiting, forever. The cleanup deadline covers all of a plugin's cleanups together.
const ACTIVATE_DEADLINE = Duration.seconds(30);
const INVOKE_DEADLINE = Duration.seconds(30);
const CLEANUP_DEADLINE = Duration.seconds(5);
const CHANNEL_BUFFER = 64;

export class PluginNotFoundError extends Schema.TaggedError<PluginNotFoundError>()(
  "PluginNotFoundError",
  { pluginId: PluginId },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} is not installed.`;
  }
}

export class PluginNotActiveError extends Schema.TaggedError<PluginNotActiveError>()(
  "PluginNotActiveError",
  { pluginId: PluginId, status: Schema.String },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} is ${this.status}.`;
  }
}

export class PluginNoServerError extends Schema.TaggedError<PluginNoServerError>()(
  "PluginNoServerError",
  { pluginId: PluginId },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} has no server half, so it has no methods or channels.`;
  }
}

export class PluginMethodNotFoundError extends Schema.TaggedError<PluginMethodNotFoundError>()(
  "PluginMethodNotFoundError",
  { pluginId: PluginId, method: Schema.String, methods: Schema.Array(Schema.String) },
) {
  // The methods it has, since nothing else lists them.
  override get message(): string {
    return `Plugin ${this.pluginId} has no method ${this.method}. Its methods: ${this.methods.join(", ") || "none"}.`;
  }
}

export class PluginAccessDeniedError extends Schema.TaggedError<PluginAccessDeniedError>()(
  "PluginAccessDeniedError",
  { pluginId: PluginId, method: Schema.String, requiredScope: AuthEnvironmentScope },
) {
  override get message(): string {
    return `Calling ${this.method} on plugin ${this.pluginId} needs the ${this.requiredScope} scope.`;
  }
}
export const isPluginAccessDeniedError = Schema.is(PluginAccessDeniedError);

// `reason` is the plugin's own error text, bounded. Plugins are trusted code, and their UI needs
// to show why its own call failed.
export class PluginHandlerError extends Schema.TaggedError<PluginHandlerError>()(
  "PluginHandlerError",
  { pluginId: PluginId, method: Schema.String, reason: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} failed in ${this.method}: ${this.reason}`;
  }
}

export class PluginHandlerTimeoutError extends Schema.TaggedError<PluginHandlerTimeoutError>()(
  "PluginHandlerTimeoutError",
  { pluginId: PluginId, method: Schema.String },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} did not answer ${this.method} within ${Duration.toSeconds(INVOKE_DEADLINE)} seconds.`;
  }
}

export class PluginHost extends Context.Service<
  PluginHost,
  {
    /**
     * The plugins now, then again after every change, as a client with `scopes` sees them: server
     * folder paths only if it manages plugins.
     */
    readonly streamForClient: (
      scopes: ReadonlyArray<AuthEnvironmentScope>,
    ) => Stream.Stream<PluginListResult>;
    /** Waits until the plugin has started or stopped. */
    readonly setEnabled: (
      pluginId: PluginId,
      enabled: boolean,
    ) => Effect.Effect<PluginState, PluginNotFoundError | PluginConfigError>;
    /** Rescans the plugin folders and restarts this plugin with fresh code. */
    readonly reload: (
      pluginId: PluginId,
    ) => Effect.Effect<PluginState, PluginNotFoundError | PluginConfigError>;
    /**
     * Rescans the plugin folders without restarting anything. Plugins whose folders appeared are
     * listed, turned off unless plugins.json turns them on; ones whose folders are gone stop, and
     * plugins.json forgets them.
     */
    readonly rescan: Effect.Effect<
      { readonly plugins: ReadonlyArray<PluginState> },
      PluginConfigError
    >;
    readonly getSettings: (
      pluginId: PluginId,
    ) => Effect.Effect<
      Omit<PluginSettingsGetResult, "pluginId">,
      PluginNotFoundError | PluginNotActiveError | PluginSettingsError
    >;
    readonly updateSettings: (
      pluginId: PluginId,
      patch: Schema.JsonObject,
    ) => Effect.Effect<
      Schema.JsonObject,
      PluginNotFoundError | PluginNotActiveError | PluginSettingsError
    >;
    /**
     * `scopes` are the caller's; methods the plugin registered as writes need the operate scope. A
     * handler that has not answered within 30 seconds is aborted.
     */
    readonly invoke: (input: {
      readonly pluginId: PluginId;
      readonly method: string;
      readonly input: Schema.Json | undefined;
      readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
    }) => Effect.Effect<
      Schema.Json,
      | PluginNotFoundError
      | PluginNotActiveError
      | PluginNoServerError
      | PluginMethodNotFoundError
      | PluginAccessDeniedError
      | PluginHandlerError
      | PluginHandlerTimeoutError
    >;
    /**
     * What an active plugin serves at `/api/plugins/<pluginId><path>`: its `web.js`, or a file in
     * its `assets/` or `styles/`. A `revision` that names the file's contents lets it be cached.
     */
    readonly readWebFile: (input: {
      readonly pluginId: string;
      readonly path: string;
      readonly revision: string | undefined;
    }) => Effect.Effect<Option.Option<PluginWebFile>>;
    /** Values the plugin publishes on `channel` until it deactivates. */
    readonly subscribe: (input: {
      readonly pluginId: PluginId;
      readonly channel: string;
    }) => Stream.Stream<
      Schema.Json,
      PluginNotFoundError | PluginNotActiveError | PluginNoServerError
    >;
  }
>()("t3/plugins/PluginHost") {}

type PluginSettingsError =
  | PluginSettingsStore.PluginSettingsPersistenceError
  | PluginSettingsStore.PluginSettingsSchemaError
  | PluginSettingsStore.PluginSettingsValidationError;

const isJson = Schema.is(Schema.Json);

interface Found {
  readonly enabled: Readonly<Record<string, boolean>>;
  readonly crashed: Readonly<Record<string, string>>;
}

// One loader for the packaged single executable and plain Node: a require created from an
// absolute path loads files from disk in both, and plugin code resolves its own imports.
const requireFromDisk = NodeModule.createRequire(process.execPath);

const isPluginDefinition = (value: unknown): value is PluginDefinition =>
  typeof value === "object" &&
  value !== null &&
  "activate" in value &&
  typeof value.activate === "function";

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = yield* Effect.context<never>();
  const services: PluginApiServices = {
    settings: yield* PluginSettingsStore.PluginSettingsStore,
    storage: yield* PluginStorage.PluginStorage,
    mcpTools: yield* PluginMcpTools.PluginMcpTools,
  };
  const settingsStore = services.settings;

  const pluginsDir = path.join(config.stateDir, "plugins");
  const pluginsConfig = yield* makePluginsConfig;
  const webFiles = yield* makePluginWebFiles;

  const records = yield* Ref.make<ReadonlyArray<PluginRecord>>([]);
  // Changes on every start, so a client can tell a restarted plugin from one that kept running.
  // Seeded with the clock so a restarted server never repeats a revision a client already saw.
  let revision = yield* Clock.currentTimeMillis;
  const nextRevision = () => ++revision;
  const lifecycle = yield* Semaphore.make(1);
  const activations = yield* FiberMap.make<PluginId>();
  const hostScope = yield* Effect.scope;

  const failures = yield* makePluginFailures;
  const pluginStates = yield* makePluginStates({
    records,
    config: pluginsConfig.current,
    failures,
  });
  const currentStates = pluginStates.current;
  const publishStates = pluginStates.publish;
  const findRecord = (pluginId: string) =>
    Ref.get(records).pipe(Effect.map((all) => all.find((record) => record.plugin.id === pluginId)));
  const stateOf = (pluginId: PluginId) =>
    currentStates.pipe(
      Effect.flatMap((states) => {
        const state = states.find((candidate) => candidate.id === pluginId);
        return state === undefined
          ? Effect.fail(new PluginNotFoundError({ pluginId }))
          : Effect.succeed(state);
      }),
    );
  const setRecord = (pluginId: PluginId, update: Omit<PluginRecord, "plugin">) =>
    Ref.update(records, (all) => {
      const index = all.findIndex((record) => record.plugin.id === pluginId);
      if (index === -1) return all;
      const next = [...all];
      next[index] = { plugin: all[index]!.plugin, ...update };
      return next;
    }).pipe(Effect.andThen(publishStates));

  // Untraced: a plugin's timer can fail every few milliseconds.
  const recordServerFailure = Effect.fnUntraced(function* (pluginId: PluginId, error: unknown) {
    const record = yield* findRecord(pluginId);
    if (yield* failures.recordServer(pluginId, record?.revision, error)) yield* publishStates;
  });
  // The guard hears of a failure in Node's own callback, so it queues it for a fiber in the host's
  // scope. Each one records in its own fiber, as one may wait out the publish interval.
  const serverFailures = yield* Queue.unbounded<readonly [PluginId, unknown]>();
  yield* Queue.take(serverFailures).pipe(
    Effect.flatMap(([pluginId, error]) =>
      Effect.forkIn(recordServerFailure(pluginId, error), hostScope),
    ),
    Effect.forever,
    Effect.forkIn(hostScope),
  );
  const failureGuard = makePluginFailureGuard({
    // Outside the plugin's scope, so the work it wakes is T3's, which the guard never blames on it.
    onRejection: (pluginId, error) =>
      pluginCodeScope.exit(() => Queue.offerUnsafe(serverFailures, [pluginId, error])),
    onCrash: (pluginId, error) => pluginsConfig.recordCrash(pluginId, errorText(error)),
  });
  // Added before the teardown finalizer, so it runs after plugin cleanups.
  yield* Effect.addFinalizer(() => Effect.sync(failureGuard.uninstall));

  // A safety net, so a plugins.json that can't be written doesn't stop a plugin from starting.
  const markStarting = (pluginId: PluginId, starting: boolean) =>
    pluginsConfig.markStarting(pluginId, starting).pipe(
      Effect.catchTags({
        PluginConfigError: (error) =>
          Effect.logWarning("could not update plugins.json", { path: error.path }),
      }),
    );

  const runCleanup = (pluginId: PluginId, cleanup: () => void | Promise<void>) =>
    Effect.tryPromise({
      try: () => pluginCodeScope.run(pluginId, () => Promise.resolve().then(cleanup)),
      catch: (cause) => new PluginCodeError({ cause }),
    }).pipe(
      Effect.catchTags({
        PluginCodeError: (error) =>
          Effect.logWarning("plugin cleanup failed", { pluginId, reason: error.message }),
      }),
    );

  // Aborts first so handlers and iterators stop. Teardown also runs where interruption is off, so
  // the deadline gets an interruptible region to cut.
  const teardown = Effect.fn("PluginHost.teardown")(function* (
    pluginId: PluginId,
    activation: PluginActivation,
  ) {
    activation.controller.abort();
    const timedOut = yield* Effect.forEach(
      activation.cleanups.toReversed(),
      (cleanup) => runCleanup(pluginId, cleanup),
      { discard: true },
    ).pipe(Effect.interruptible, Effect.timeoutOption(CLEANUP_DEADLINE), Effect.map(Option.isNone));
    if (timedOut) yield* Effect.logWarning("plugin cleanup timed out", { pluginId });
    // In one step with the abort, so a subscriber that joins meanwhile sees one or the other.
    activation.ended.abort();
    for (const queues of activation.channels.values()) {
      for (const queue of queues) Queue.endUnsafe(queue);
    }
  });

  const loadDefinition = (plugin: DiscoveredPlugin, entry: string) =>
    Effect.try({
      try: () => {
        const entryPath = path.join(plugin.rootDir, entry);
        // Drop every cached module under the plugin so reload runs current code. Node still
        // holds the old instances until the server restarts.
        const prefix = `${plugin.rootDir}${path.sep}`;
        for (const cached of Object.keys(requireFromDisk.cache)) {
          if (cached.startsWith(prefix)) Reflect.deleteProperty(requireFromDisk.cache, cached);
        }
        const exported: unknown = pluginCodeScope.run(plugin.id, () => requireFromDisk(entryPath));
        // Bundlers that compile `export default` to CommonJS put the definition on `default`.
        const definition =
          typeof exported === "object" && exported !== null && "default" in exported
            ? exported.default
            : exported;
        if (!isPluginDefinition(definition)) {
          throw new Error("The server entry does not export a plugin with an activate function.");
        }
        return definition;
      },
      catch: (cause) => new PluginCodeError({ cause }),
    });

  const activatePlugin = Effect.fn("PluginHost.activate")(function* (plugin: DiscoveredPlugin) {
    const manifest = manifestOf(plugin);
    if (manifest === undefined) return;
    if (!satisfiesSemverRange(packageJson.version, manifest.engines.t3)) {
      return yield* setRecord(plugin.id, {
        status: "failed",
        failure: {
          stage: "compatibility",
          message: `Needs T3 Code ${manifest.engines.t3}; this server is ${packageJson.version}.`,
        },
      });
    }
    // Before Node 24, `pluginCodeScope` slows every promise in the process about 3x, and without
    // it a plugin's rejection with only Node's frames in its stack stops the server.
    const node = process.versions.node;
    if (manifest.server !== undefined && Number(node.split(".")[0]) < 24) {
      return yield* setRecord(plugin.id, {
        status: "failed",
        failure: {
          stage: "compatibility",
          message: `Needs Node 24 or later for its server code; this server runs Node ${node}.`,
        },
      });
    }
    const web = yield* webFiles.find(plugin, manifest.web);
    const started = {
      status: "active" as const,
      webFiles: web.folders,
      ...(web.webRevision === undefined ? {} : { webRevision: web.webRevision }),
      styles: web.styles,
    };
    if (manifest.server === undefined) {
      return yield* setRecord(plugin.id, { ...started, revision: nextRevision() });
    }
    yield* setRecord(plugin.id, { status: "loading" });
    const server = manifest.server;
    // Marked while its code loads and activates, so a start that ends the server, such as with
    // process.exit, leaves the mark for the next start to find.
    yield* Effect.acquireUseRelease(
      markStarting(plugin.id, true),
      () =>
        Effect.gen(function* () {
          // Before loading, since a module can start timers as it loads.
          failureGuard.watch(`${plugin.rootDir}${path.sep}`, plugin.id);
          const definition = yield* Effect.exit(loadDefinition(plugin, server));
          if (definition._tag === "Failure") {
            return yield* setRecord(plugin.id, {
              status: "failed",
              failure: { stage: "load", message: errorText(Cause.squash(definition.cause)) },
            });
          }
          const activation = makePluginActivation();
          const api = makePluginApi({
            id: plugin.id,
            rootDir: plugin.rootDir,
            settingsSchema: manifest.settingsSchema,
            activation,
            context,
            services,
          });
          // Only `activate` can be interrupted. A stop that lands after it waits until the record
          // holds the activation, so `stopPlugin` always finds what to tear down.
          yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const activated = yield* restore(
                Effect.tryPromise({
                  try: () =>
                    pluginCodeScope.run(plugin.id, () =>
                      Promise.resolve().then(() => definition.value.activate(api)),
                    ),
                  catch: (cause) => new PluginCodeError({ cause }),
                }).pipe(Effect.timeoutOption(ACTIVATE_DEADLINE)),
              ).pipe(Effect.exit);
              if (activated._tag === "Success" && Option.isSome(activated.value)) {
                yield* setRecord(plugin.id, { ...started, activation, revision: nextRevision() });
                return yield* Effect.logInfo("plugin activated", { pluginId: plugin.id });
              }
              yield* teardown(plugin.id, activation);
              // Whatever stopped the activation sets the plugin's next status.
              if (activated._tag === "Failure" && Cause.hasInterruptsOnly(activated.cause)) return;
              yield* setRecord(plugin.id, {
                status: "failed",
                failure: {
                  stage: "activate",
                  message:
                    activated._tag === "Failure"
                      ? errorText(Cause.squash(activated.cause))
                      : `activate did not finish within ${Duration.toSeconds(ACTIVATE_DEADLINE)} seconds.`,
                },
              });
            }),
          );
        }),
      () => markStarting(plugin.id, false),
    );
  });

  /**
   * An active plugin's record stops routing calls and serving files before cleanups run. The caller
   * sets the plugin's next status.
   */
  const stopPlugin = Effect.fn("PluginHost.stop")(function* (pluginId: PluginId) {
    yield* FiberMap.remove(activations, pluginId);
    // A failure from before the stop, even one while loading, which has no revision, belongs to
    // that start; failures of code left running after it are recorded again.
    yield* failures.clearServer(pluginId);
    // A plugin without server code is active with no activation.
    const record = yield* findRecord(pluginId);
    if (record?.status !== "active") return;
    yield* setRecord(pluginId, { status: "disabled" });
    if (record.activation !== undefined) yield* teardown(pluginId, record.activation);
  });

  const startPlugin = (plugin: DiscoveredPlugin) =>
    config.noPlugins === true
      ? setRecord(plugin.id, {
          status: "disabled",
          failure: {
            stage: "skipped",
            message:
              "T3 Code started with --no-plugins, so no plugin runs until it restarts without it.",
          },
        })
      : FiberMap.run(activations, plugin.id, activatePlugin(plugin)).pipe(Effect.asVoid);

  // A plugin that stopped the server was turned off then, or the restart would only crash again.
  const initialRecord = (plugin: DiscoveredPlugin, found: Found): PluginRecord => {
    if ("failure" in plugin) return { plugin, status: "failed", failure: plugin.failure };
    const crashed = found.crashed[plugin.id];
    if (crashed !== undefined) {
      return { plugin, status: "failed", failure: { stage: "crash", message: crashed } };
    }
    return found.enabled[plugin.id] === true
      ? { plugin, status: "loading" }
      : { plugin, status: "disabled" };
  };
  const startsAtDiscovery = (plugin: DiscoveredPlugin, found: Found) =>
    initialRecord(plugin, found).status === "loading";

  // Startup tolerates an unreadable plugins.json; an explicit reload reports it instead.
  const discover = Effect.fn("PluginHost.discover")(function* (lenient: boolean) {
    const current = yield* pluginsConfig.reread(lenient);
    const { plugins, complete } = yield* discoverPlugins({
      pluginsDir,
      devPaths: current.devPaths ?? [],
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    // Only folders that are gone: one it could not read, such as on a drive mounted later, would
    // otherwise come back turned off.
    if (complete) {
      yield* pluginsConfig.forgetMissing(new Set(plugins.map((plugin) => plugin.id))).pipe(
        Effect.catchTags({
          PluginConfigError: (error) =>
            lenient
              ? Effect.logWarning("could not update plugins.json", { path: error.path })
              : Effect.fail(error),
        }),
      );
    }
    const found: Found = { enabled: current.enabled ?? {}, crashed: current.crashed ?? {} };
    return { plugins, found };
  });

  // Lifecycle changes run in the host's scope, so a caller that disconnects only stops waiting
  // and never leaves a plugin half torn down.
  const runLifecycle = <A, E>(body: Effect.Effect<A, E>) =>
    lifecycle.withPermits(1)(body).pipe(Effect.forkIn(hostScope), Effect.flatMap(Fiber.join));

  const awaitActivation = (pluginId: PluginId) =>
    FiberMap.get(activations, pluginId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (fiber) => Effect.asVoid(Fiber.await(fiber)),
        }),
      ),
    );

  const setEnabled: PluginHost["Service"]["setEnabled"] = Effect.fn("PluginHost.setEnabled")(
    function* (pluginId, enabled) {
      yield* runLifecycle(
        Effect.gen(function* () {
          const record = yield* findRecord(pluginId);
          if (record === undefined) return yield* new PluginNotFoundError({ pluginId });
          yield* pluginsConfig.writeEnabled(pluginId, enabled);
          if ("failure" in record.plugin) return yield* publishStates;
          if (enabled && (record.status === "active" || record.status === "loading")) {
            return yield* publishStates;
          }
          yield* stopPlugin(pluginId);
          if (enabled) {
            yield* startPlugin(record.plugin);
          } else {
            yield* setRecord(pluginId, { status: "disabled" });
          }
        }),
      );
      yield* awaitActivation(pluginId);
      return yield* stateOf(pluginId);
    },
  );

  /** `restart` also restarts that plugin with fresh code. */
  const rediscover = Effect.fn("PluginHost.rediscover")(function* (restart: PluginId | undefined) {
    // Reloading a plugin that stopped the server clears that failure; it stays off until turned on.
    if (restart !== undefined) yield* pluginsConfig.clearCrash(restart);
    const { plugins, found } = yield* discover(false);
    if (restart !== undefined) yield* stopPlugin(restart);
    const known = yield* Ref.get(records);
    const next = plugins.map((plugin) => ({
      plugin,
      kept:
        plugin.id === restart || "failure" in plugin
          ? undefined
          : known.find(
              (record) =>
                record.plugin.id === plugin.id &&
                record.plugin.folder === plugin.folder &&
                !("failure" in record.plugin),
            ),
    }));
    // Copies that are gone or moved stop, or they would keep running unlisted.
    for (const record of known) {
      if (
        record.plugin.id !== restart &&
        !("failure" in record.plugin) &&
        !next.some(({ kept }) => kept === record)
      ) {
        yield* stopPlugin(record.plugin.id);
      }
    }
    // Kept records are read again here: one still starting may have finished while others stopped.
    yield* Ref.update(records, (current) =>
      next.map(({ plugin, kept }) => {
        if (kept === undefined) return initialRecord(plugin, found);
        const latest = current.find((record) => record.plugin === kept.plugin) ?? kept;
        // One that runs nothing takes the files found now, so starting it loads their manifest.
        return latest.status === "active" || latest.status === "loading"
          ? latest
          : { ...latest, plugin };
      }),
    );
    yield* publishStates;
    for (const { plugin, kept } of next) {
      if (kept === undefined && startsAtDiscovery(plugin, found)) yield* startPlugin(plugin);
    }
    return plugins;
  });

  const reload: PluginHost["Service"]["reload"] = Effect.fn("PluginHost.reload")(
    function* (pluginId) {
      yield* runLifecycle(
        rediscover(pluginId).pipe(
          Effect.flatMap((plugins) =>
            plugins.some((plugin) => plugin.id === pluginId)
              ? Effect.void
              : Effect.fail(new PluginNotFoundError({ pluginId })),
          ),
        ),
      );
      yield* awaitActivation(pluginId);
      return yield* stateOf(pluginId);
    },
  );

  const rescan = Effect.fn("PluginHost.rescan")(function* () {
    // The docs tell people to copy plugin folders here, so it has to exist.
    yield* fs.makeDirectory(pluginsDir, { recursive: true }).pipe(Effect.ignore);
    yield* runLifecycle(rediscover(undefined));
    return { plugins: yield* currentStates };
  });

  // Lookups inside an operation that already has its span.
  const manifestFor = Effect.fnUntraced(function* (pluginId: PluginId) {
    const record = yield* findRecord(pluginId);
    if (record === undefined) return yield* new PluginNotFoundError({ pluginId });
    const manifest = manifestOf(record.plugin);
    if (manifest === undefined) {
      return yield* new PluginNotActiveError({ pluginId, status: record.status });
    }
    return manifest;
  });

  const activeRecord = Effect.fnUntraced(function* (pluginId: PluginId) {
    const record = yield* findRecord(pluginId);
    if (record === undefined) return yield* new PluginNotFoundError({ pluginId });
    const manifest = manifestOf(record.plugin);
    if (manifest !== undefined && manifest.server === undefined) {
      return yield* new PluginNoServerError({ pluginId });
    }
    if (record.status !== "active" || record.activation === undefined) {
      return yield* new PluginNotActiveError({ pluginId, status: record.status });
    }
    return record.activation;
  });

  const { installer, recoverStaging } = yield* PluginInstaller.make({
    lifecycle: runLifecycle,
    plugins: Ref.get(records).pipe(Effect.map((all) => all.map((record) => record.plugin))),
    pluginOf: (pluginId) =>
      findRecord(pluginId).pipe(
        Effect.flatMap((record) =>
          record === undefined
            ? Effect.fail(new PluginNotFoundError({ pluginId }))
            : Effect.succeed(record.plugin),
        ),
      ),
    stop: stopPlugin,
    rescan: rediscover(undefined).pipe(Effect.asVoid),
    reload,
    config: pluginsConfig.current,
    writeConfig: pluginsConfig.write,
  });

  const startup = lifecycle
    .withPermits(1)(
      Effect.gen(function* () {
        yield* recoverStaging;
        yield* pluginsConfig.recoverStarting.pipe(
          Effect.catchTags({
            PluginConfigError: (error) =>
              Effect.logWarning("could not update plugins.json", { path: error.path }),
          }),
        );
        const { plugins, found } = yield* discover(true);
        yield* Ref.set(
          records,
          plugins.map((plugin) => initialRecord(plugin, found)),
        );
        yield* publishStates;
        // Each plugin activates in its own fiber, so a slow one delays nobody else.
        for (const plugin of plugins) {
          if (startsAtDiscovery(plugin, found)) yield* startPlugin(plugin);
        }
      }),
    )
    .pipe(Effect.withSpan("PluginHost.startup"));

  yield* forkParked(startup);
  yield* Effect.addFinalizer(() =>
    Ref.get(records).pipe(
      Effect.flatMap((all) =>
        Effect.forEach(
          all,
          (record) =>
            record.activation === undefined
              ? Effect.void
              : teardown(record.plugin.id, record.activation),
          { concurrency: "unbounded", discard: true },
        ),
      ),
    ),
  );

  const service = PluginHost.of({
    streamForClient: pluginStates.streamForClient,
    setEnabled,
    reload,
    rescan: rescan(),
    getSettings: Effect.fn("PluginHost.getSettings")(function* (pluginId) {
      const { settingsSchema } = yield* manifestFor(pluginId);
      const settings = yield* settingsStore.getForClient(pluginId, settingsSchema);
      return settingsSchema === undefined ? { settings } : { settings, settingsSchema };
    }),
    // Under the lifecycle lock, so a removal can't delete the plugin between the check and the
    // save and leave settings behind that no plugin reaches.
    updateSettings: Effect.fn("PluginHost.updateSettings")(function* (pluginId, patch) {
      return yield* runLifecycle(
        manifestFor(pluginId).pipe(
          Effect.flatMap((manifest) =>
            settingsStore.update(pluginId, manifest.settingsSchema, patch),
          ),
        ),
      );
    }),
    invoke: Effect.fn("PluginHost.invoke")(function* (request) {
      yield* Effect.annotateCurrentSpan({
        "plugin.id": request.pluginId,
        "plugin.method": request.method,
      });
      const activation = yield* activeRecord(request.pluginId);
      const registered = activation.methods.get(request.method);
      if (registered === undefined) {
        return yield* new PluginMethodNotFoundError({
          pluginId: request.pluginId,
          method: request.method,
          methods: [...activation.methods.keys()],
        });
      }
      const access = request.scopes.includes(AuthOrchestrationOperateScope) ? "write" : "read";
      if (registered.access === "write" && access !== "write") {
        return yield* new PluginAccessDeniedError({
          pluginId: request.pluginId,
          method: request.method,
          requiredScope: AuthOrchestrationOperateScope,
        });
      }
      const handlerError = (cause: unknown) =>
        new PluginHandlerError({
          pluginId: request.pluginId,
          method: request.method,
          reason: errorText(cause),
          cause,
        });
      const deactivated = activation.controller.signal;
      const answered = yield* Effect.raceFirst(
        // The deadline interrupts the call, which aborts the handler's signal.
        Effect.tryPromise({
          try: (signal) =>
            pluginCodeScope.run(request.pluginId, () =>
              Promise.resolve().then(() =>
                registered.handler(request.input, {
                  signal: AbortSignal.any([signal, deactivated]),
                  access,
                }),
              ),
            ),
          catch: handlerError,
        }).pipe(Effect.timeoutOption(INVOKE_DEADLINE)),
        // A handler that ignores its abort signal must not hold the call open after disable.
        Effect.callback<never, PluginNotActiveError>((resume) => {
          const onAbort = () =>
            resume(
              Effect.fail(
                new PluginNotActiveError({ pluginId: request.pluginId, status: "disabled" }),
              ),
            );
          if (deactivated.aborted) return onAbort();
          deactivated.addEventListener("abort", onAbort, { once: true });
          return Effect.sync(() => deactivated.removeEventListener("abort", onAbort));
        }),
      );
      if (Option.isNone(answered)) {
        return yield* new PluginHandlerTimeoutError({
          pluginId: request.pluginId,
          method: request.method,
        });
      }
      const output = answered.value;
      if (output === undefined) return null;
      if (!isJson(output)) {
        return yield* handlerError(new TypeError("The method returned a value that is not JSON."));
      }
      const size = jsonKilobytes(output);
      if (size > MAX_MESSAGE_KILOBYTES) {
        return yield* handlerError(
          new RangeError(
            `The result is ${size} KB as JSON, and a result can be at most ${MAX_MESSAGE_KILOBYTES} KB.`,
          ),
        );
      }
      return output;
    }),
    readWebFile: Effect.fn("PluginHost.readWebFile")(function* (request) {
      const record = yield* findRecord(request.pluginId);
      if (record?.status !== "active" || record.webFiles === undefined) return Option.none();
      return yield* webFiles.read(
        record.plugin.rootDir,
        record.webFiles,
        request.path,
        request.revision,
      );
    }),
    subscribe: (request) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const activation = yield* activeRecord(request.pluginId);
          const queue = yield* Queue.sliding<Schema.Json, Cause.Done>(CHANNEL_BUFFER);
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              if (activation.ended.signal.aborted) return Queue.endUnsafe(queue);
              const queues = activation.channels.get(request.channel) ?? new Set();
              activation.channels.set(request.channel, queues.add(queue));
            }),
            () =>
              Effect.sync(() => {
                const queues = activation.channels.get(request.channel);
                queues?.delete(queue);
                if (queues?.size === 0) activation.channels.delete(request.channel);
              }),
          );
          return Stream.fromQueue(queue);
        }),
      ),
  });
  return Context.make(PluginHost, service).pipe(
    Context.add(PluginInstaller.PluginInstaller, installer),
  );
});

export const layer = Layer.effectContext(make);

const WEB_FILES_ROUTE_PREFIX = "/api/plugins";

export const layerWebFilesRoute = HttpRouter.add(
  "GET",
  `${WEB_FILES_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    // Same sign-in as reads on the rest of `/api`.
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    const url = HttpServerRequest.toURL(yield* HttpServerRequest.HttpServerRequest);
    if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
    const rest = url.value.pathname.slice(`${WEB_FILES_ROUTE_PREFIX}/`.length);
    const slash = rest.indexOf("/");
    const host = yield* PluginHost;
    const file = yield* host.readWebFile({
      pluginId: slash === -1 ? rest : rest.slice(0, slash),
      path: slash === -1 ? "/" : rest.slice(slash),
      revision: url.value.searchParams.get("v") ?? undefined,
    });
    return Option.match(file, {
      onNone: () => HttpServerResponse.text("Not Found", { status: 404 }),
      onSome: ({ headers, body }) => HttpServerResponse.uint8Array(body, { headers }),
    });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);
