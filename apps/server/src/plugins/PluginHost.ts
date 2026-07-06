import {
  HOST_API_VERSION,
  PluginManifest,
  hostApiSatisfies,
  type PluginId,
  type PluginLockfile,
  type PluginLockfilePlugin,
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

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import { PluginLockfileStore } from "./PluginLockfileStore.ts";
import { PluginMigrator } from "./PluginMigrator.ts";
import { PluginModuleLoader } from "./PluginModuleLoader.ts";
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

const makeLogger = (pluginId: PluginId): PluginLogger => ({
  debug: (message, attributes) => Effect.logDebug(message, { ...attributes, pluginId }),
  info: (message, attributes) => Effect.logInfo(message, { ...attributes, pluginId }),
  warn: (message, attributes) => Effect.logWarning(message, { ...attributes, pluginId }),
  error: (message, attributes) => Effect.logError(message, { ...attributes, pluginId }),
});

const unavailable = (capability: string) =>
  Effect.die(new PluginCapabilityUnavailable({ capability }));

const makeHostApi = (input: {
  readonly pluginId: PluginId;
  readonly dataDir: string;
  readonly logger: PluginLogger;
}): PluginHostApi => ({
  hostApiVersion: HOST_API_VERSION,
  config: {
    appVersion: APP_VERSION,
    hostApiVersion: HOST_API_VERSION,
    dataDir: input.dataDir,
    logger: input.logger,
  },
  agents: unavailable("agents"),
  vcs: unavailable("vcs"),
  terminals: unavailable("terminals"),
  database: unavailable("database"),
  projectionsRead: unavailable("projections.read"),
  environmentsRead: unavailable("environments.read"),
  secrets: unavailable("secrets"),
  http: unavailable("http"),
  sourceControl: unavailable("sourceControl"),
  textGeneration: unavailable("textGeneration"),
});

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
  const clock = yield* Clock.Clock;

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
        yield* store.updatePlugin(pluginId, ({ current }) =>
          Effect.succeed(current ? { ...current, state: "disabled-by-host" } : undefined),
        );
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
        yield* updateFailure(store, pluginId, "plugin directory or server entry is missing");
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
      const logger = makeLogger(pluginId);
      const dataDir = pluginDataDir(config.pluginsDir, pluginId, path.join);
      const hostApi = makeHostApi({ pluginId, dataDir, logger });

      const activation = Effect.gen(function* () {
        yield* fs.makeDirectory(dataDir, { recursive: true });
        const definition = yield* loader.loadServerEntry(pluginDir, serverEntry);
        const registration = yield* resolveRegistration(pluginId, definition, hostApi);
        yield* validateRegistration(pluginId, registration);
        yield* migrator.run(pluginId, registration.migrations ?? []);
        if (registration.recover) {
          yield* registration.recover();
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
        yield* updateFailure(store, pluginId, message);
        yield* Effect.logWarning("Plugin activation failed", { pluginId, cause: message });
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
          yield* updateFailure(
            store,
            pluginId,
            "pending upgrade is missing staged plugin metadata",
          );
          return false;
        }
        const staged = entry.staged;
        yield* store.updatePlugin(pluginId, ({ current }) =>
          Effect.succeed(current ? upgradeLockfileEntry(current, staged) : undefined),
        );
        return true;
      }
      if (entry.activation.activatingSince !== null) {
        const crashCount = entry.activation.crashCount + 1;
        if (crashCount >= 2) {
          yield* store.updatePlugin(pluginId, ({ current }) =>
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
          );
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
          updateFailure(store, pluginId, Cause.pretty(cause)).pipe(
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
