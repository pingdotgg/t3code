/**
 * CliConfig - CLI/runtime bootstrap service definitions.
 *
 * Defines startup-only service contracts used while resolving process config
 * and constructing server runtime layers.
 *
 * @module CliConfig
 */
import { Config, Data, Effect, FileSystem, Layer, Option, Path, Schema, ServiceMap } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { NetService } from "@t3tools/shared/Net";
import {
  DEFAULT_PORT,
  deriveServerPaths,
  resolveStaticDir,
  ServerConfig,
  type RuntimeMode,
  type ServerConfigShape,
} from "./config";
import { fixPath, resolveBaseDir } from "./os-jank";
import { Open } from "./open";
import * as SqlitePersistence from "./persistence/Layers/Sqlite";
import { makeServerProviderLayer, makeServerRuntimeServicesLayer } from "./serverLayers";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { ProviderRegistryLive } from "./provider/Layers/ProviderRegistry";
import { Server } from "./wsServer";
import { ServerLoggerLive } from "./serverLogger";
import { AnalyticsServiceLayerLive } from "./telemetry/Layers/AnalyticsService";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService";
import { readBootstrapEnvelope } from "./bootstrap";
import { ServerSettingsLive } from "./serverSettings";

export class StartupError extends Data.TaggedError("StartupError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const PortSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));

const BootstrapEnvelopeSchema = Schema.Struct({
  mode: Schema.optional(Schema.String),
  port: Schema.optional(PortSchema),
  host: Schema.optional(Schema.String),
  t3Home: Schema.optional(Schema.String),
  devUrl: Schema.optional(Schema.URLFromString),
  noBrowser: Schema.optional(Schema.Boolean),
  authToken: Schema.optional(Schema.String),
  autoBootstrapProjectFromCwd: Schema.optional(Schema.Boolean),
  logWebSocketEvents: Schema.optional(Schema.Boolean),
});

interface CliInput {
  readonly mode: Option.Option<RuntimeMode>;
  readonly port: Option.Option<number>;
  readonly host: Option.Option<string>;
  readonly t3Home: Option.Option<string>;
  readonly devUrl: Option.Option<URL>;
  readonly noBrowser: Option.Option<boolean>;
  readonly authToken: Option.Option<string>;
  readonly bootstrapFd: Option.Option<number>;
  readonly autoBootstrapProjectFromCwd: Option.Option<boolean>;
  readonly logWebSocketEvents: Option.Option<boolean>;
}

/**
 * CliConfigShape - Startup helpers required while building server layers.
 */
export interface CliConfigShape {
  /**
   * Current process working directory.
   */
  readonly cwd: string;

  /**
   * Apply OS-specific PATH normalization.
   */
  readonly fixPath: Effect.Effect<void>;

  /**
   * Resolve static web asset directory for server mode.
   */
  readonly resolveStaticDir: Effect.Effect<string | undefined>;
}

/**
 * CliConfig - Service tag for startup CLI/runtime helpers.
 */
export class CliConfig extends ServiceMap.Service<CliConfig, CliConfigShape>()(
  "t3/main/CliConfig",
) {
  static readonly layer = Layer.effect(
    CliConfig,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      return {
        cwd: process.cwd(),
        fixPath: Effect.sync(fixPath),
        resolveStaticDir: resolveStaticDir().pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      } satisfies CliConfigShape;
    }),
  );
}

const CliEnvConfig = Config.all({
  mode: Config.string("T3CODE_MODE").pipe(
    Config.option,
    Config.map(Option.map((value) => (value === "desktop" ? "desktop" : "web"))),
    Config.map(Option.getOrUndefined),
  ),
  port: Config.port("T3CODE_PORT").pipe(Config.option, Config.map(Option.getOrUndefined)),
  host: Config.string("T3CODE_HOST").pipe(Config.option, Config.map(Option.getOrUndefined)),
  t3Home: Config.string("T3CODE_HOME").pipe(Config.option, Config.map(Option.getOrUndefined)),
  devUrl: Config.url("VITE_DEV_SERVER_URL").pipe(Config.option, Config.map(Option.getOrUndefined)),
  noBrowser: Config.boolean("T3CODE_NO_BROWSER").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  authToken: Config.string("T3CODE_AUTH_TOKEN").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  bootstrapFd: Config.int("T3CODE_BOOTSTRAP_FD").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  autoBootstrapProjectFromCwd: Config.boolean("T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  logWebSocketEvents: Config.boolean("T3CODE_LOG_WS_EVENTS").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
});

const resolveBooleanFlag = (flag: Option.Option<boolean>, envValue: boolean) =>
  Option.getOrElse(Option.filter(flag, Boolean), () => envValue);

const resolveOptionPrecedence = <Value>(
  ...values: ReadonlyArray<Option.Option<Value>>
): Option.Option<Value> => Option.firstSomeOf(values);

const isValidPort = (value: number): boolean => value >= 1 && value <= 65_535;
const isRuntimeMode = (value: string): value is RuntimeMode =>
  value === "web" || value === "desktop";

const ServerConfigLive = (input: CliInput) =>
  Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const cliConfig = yield* CliConfig;
      const { findAvailablePort } = yield* NetService;
      const env = yield* CliEnvConfig.asEffect().pipe(
        Effect.mapError(
          (cause) =>
            new StartupError({ message: "Failed to read environment configuration", cause }),
        ),
      );

      const bootstrapFd = Option.getOrUndefined(input.bootstrapFd) ?? env.bootstrapFd;
      const bootstrapEnvelope =
        bootstrapFd !== undefined
          ? yield* readBootstrapEnvelope(BootstrapEnvelopeSchema, bootstrapFd)
          : Option.none();

      const mode: RuntimeMode = Option.getOrElse(
        resolveOptionPrecedence(
          input.mode,
          Option.fromUndefinedOr(env.mode),
          Option.flatMap(bootstrapEnvelope, (bootstrap) =>
            Option.filter(Option.fromUndefinedOr(bootstrap.mode), isRuntimeMode),
          ),
        ),
        () => "web",
      );
      const port = yield* Option.match(
        resolveOptionPrecedence(
          input.port,
          Option.fromUndefinedOr(env.port),
          Option.flatMap(bootstrapEnvelope, (bootstrap) =>
            Option.filter(Option.fromUndefinedOr(bootstrap.port), isValidPort),
          ),
        ),
        {
          onSome: (value) => Effect.succeed(value),
          onNone: () => {
            if (mode === "desktop") {
              return Effect.succeed(DEFAULT_PORT);
            }
            return findAvailablePort(DEFAULT_PORT);
          },
        },
      );

      const devUrl = Option.getOrElse(
        resolveOptionPrecedence(
          input.devUrl,
          Option.fromUndefinedOr(env.devUrl),
          Option.flatMap(bootstrapEnvelope, (bootstrap) =>
            Option.fromUndefinedOr(bootstrap.devUrl),
          ),
        ),
        () => undefined,
      );
      const baseDir = yield* resolveBaseDir(
        Option.getOrUndefined(
          resolveOptionPrecedence(
            input.t3Home,
            Option.fromUndefinedOr(env.t3Home),
            Option.flatMap(bootstrapEnvelope, (bootstrap) =>
              Option.fromUndefinedOr(bootstrap.t3Home),
            ),
          ),
        ),
      );
      const derivedPaths = yield* deriveServerPaths(baseDir, devUrl);
      const noBrowser = resolveBooleanFlag(
        input.noBrowser,
        Option.getOrElse(
          resolveOptionPrecedence(
            Option.fromUndefinedOr(env.noBrowser),
            Option.flatMap(bootstrapEnvelope, (bootstrap) =>
              Option.fromUndefinedOr(bootstrap.noBrowser),
            ),
          ),
          () => mode === "desktop",
        ),
      );
      const authToken = resolveOptionPrecedence(
        input.authToken,
        Option.fromUndefinedOr(env.authToken),
        Option.flatMap(bootstrapEnvelope, (bootstrap) =>
          Option.fromUndefinedOr(bootstrap.authToken),
        ),
      );
      const autoBootstrapProjectFromCwd = resolveBooleanFlag(
        input.autoBootstrapProjectFromCwd,
        Option.getOrElse(
          resolveOptionPrecedence(
            Option.fromUndefinedOr(env.autoBootstrapProjectFromCwd),
            Option.flatMap(bootstrapEnvelope, (bootstrap) =>
              Option.fromUndefinedOr(bootstrap.autoBootstrapProjectFromCwd),
            ),
          ),
          () => mode === "web",
        ),
      );
      const logWebSocketEvents = resolveBooleanFlag(
        input.logWebSocketEvents,
        Option.getOrElse(
          resolveOptionPrecedence(
            Option.fromUndefinedOr(env.logWebSocketEvents),
            Option.flatMap(bootstrapEnvelope, (bootstrap) =>
              Option.fromUndefinedOr(bootstrap.logWebSocketEvents),
            ),
          ),
          () => Boolean(devUrl),
        ),
      );
      const staticDir = devUrl ? undefined : yield* cliConfig.resolveStaticDir;
      const host = Option.getOrElse(
        resolveOptionPrecedence(
          input.host,
          Option.fromUndefinedOr(env.host),
          Option.flatMap(bootstrapEnvelope, (bootstrap) => Option.fromUndefinedOr(bootstrap.host)),
        ),
        () => (mode === "desktop" ? "127.0.0.1" : undefined),
      );

      const config: ServerConfigShape = {
        mode,
        port,
        cwd: cliConfig.cwd,
        host,
        baseDir,
        ...derivedPaths,
        staticDir,
        devUrl,
        noBrowser,
        authToken: Option.getOrUndefined(authToken),
        autoBootstrapProjectFromCwd,
        logWebSocketEvents,
      } satisfies ServerConfigShape;

      return config;
    }),
  );

const LayerLive = (input: CliInput) =>
  Layer.empty.pipe(
    Layer.provideMerge(makeServerRuntimeServicesLayer()),
    Layer.provideMerge(makeServerProviderLayer()),
    Layer.provideMerge(ProviderRegistryLive),
    Layer.provideMerge(SqlitePersistence.layerConfig),
    Layer.provideMerge(ServerLoggerLive),
    Layer.provideMerge(AnalyticsServiceLayerLive),
    Layer.provideMerge(ServerSettingsLive),
    Layer.provideMerge(ServerConfigLive(input)),
  );

const isWildcardHost = (host: string | undefined): boolean =>
  host === "0.0.0.0" || host === "::" || host === "[::]";

const formatHostForUrl = (host: string): string =>
  host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

export const recordStartupHeartbeat = Effect.gen(function* () {
  const analytics = yield* AnalyticsService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const { threadCount, projectCount } = yield* projectionSnapshotQuery.getSnapshot().pipe(
    Effect.map((snapshot) => ({
      threadCount: snapshot.threads.length,
      projectCount: snapshot.projects.length,
    })),
    Effect.catch((cause) =>
      Effect.logWarning("failed to gather startup snapshot for telemetry", { cause }).pipe(
        Effect.as({
          threadCount: 0,
          projectCount: 0,
        }),
      ),
    ),
  );

  yield* analytics.record("server.boot.heartbeat", {
    threadCount,
    projectCount,
  });
});

const makeServerRuntimeProgram = (input: CliInput) =>
  Effect.gen(function* () {
    const { start, stopSignal } = yield* Server;
    const openDeps = yield* Open;

    const config = yield* ServerConfig;

    if (!config.devUrl && !config.staticDir) {
      yield* Effect.logWarning(
        "web bundle missing and no VITE_DEV_SERVER_URL; web UI unavailable",
        {
          hint: "Run `bun run --cwd apps/web build` or set VITE_DEV_SERVER_URL for dev mode.",
        },
      );
    }

    yield* start;
    yield* Effect.forkChild(recordStartupHeartbeat);

    const localUrl = `http://localhost:${config.port}`;
    const bindUrl =
      config.host && !isWildcardHost(config.host)
        ? `http://${formatHostForUrl(config.host)}:${config.port}`
        : localUrl;
    const { authToken, devUrl, ...safeConfig } = config;
    yield* Effect.logInfo("T3 Code running", {
      ...safeConfig,
      devUrl: devUrl?.toString(),
      authEnabled: Boolean(authToken),
    });

    if (!config.noBrowser) {
      const target = config.devUrl?.toString() ?? bindUrl;
      yield* openDeps.openBrowser(target).pipe(
        Effect.catch(() =>
          Effect.logInfo("browser auto-open unavailable", {
            hint: `Open ${target} in your browser.`,
          }),
        ),
      );
    }

    return yield* stopSignal;
  }).pipe(Effect.provide(LayerLive(input)));

const makeServerProgram = (input: CliInput) =>
  Effect.gen(function* () {
    const cliConfig = yield* CliConfig;
    yield* cliConfig.fixPath;
    return yield* makeServerRuntimeProgram(input);
  });

/**
 * These flags mirrors the environment variables and the config shape.
 */

const modeFlag = Flag.choice("mode", ["web", "desktop"]).pipe(
  Flag.withDescription("Runtime mode. `desktop` keeps loopback defaults unless overridden."),
  Flag.optional,
);
const portFlag = Flag.integer("port").pipe(
  Flag.withSchema(PortSchema),
  Flag.withDescription("Port for the HTTP/WebSocket server."),
  Flag.optional,
);
const hostFlag = Flag.string("host").pipe(
  Flag.withDescription("Host/interface to bind (for example 127.0.0.1, 0.0.0.0, or a Tailnet IP)."),
  Flag.optional,
);
const t3HomeFlag = Flag.string("home-dir").pipe(
  Flag.withDescription("Base directory for all T3 Code data (equivalent to T3CODE_HOME)."),
  Flag.optional,
);
const devUrlFlag = Flag.string("dev-url").pipe(
  Flag.withSchema(Schema.URLFromString),
  Flag.withDescription("Dev web URL to proxy/redirect to (equivalent to VITE_DEV_SERVER_URL)."),
  Flag.optional,
);
const noBrowserFlag = Flag.boolean("no-browser").pipe(
  Flag.withDescription("Disable automatic browser opening."),
  Flag.optional,
);
const authTokenFlag = Flag.string("auth-token").pipe(
  Flag.withDescription("Auth token required for WebSocket connections."),
  Flag.withAlias("token"),
  Flag.optional,
);
const bootstrapFdFlag = Flag.integer("bootstrap-fd").pipe(
  Flag.withSchema(Schema.Int),
  Flag.withDescription("Read one-time bootstrap secrets from the given file descriptor."),
  Flag.optional,
);
const autoBootstrapProjectFromCwdFlag = Flag.boolean("auto-bootstrap-project-from-cwd").pipe(
  Flag.withDescription(
    "Create a project for the current working directory on startup when missing.",
  ),
  Flag.optional,
);
const logWebSocketEventsFlag = Flag.boolean("log-websocket-events").pipe(
  Flag.withDescription(
    "Emit server-side logs for outbound WebSocket push traffic (equivalent to T3CODE_LOG_WS_EVENTS).",
  ),
  Flag.withAlias("log-ws-events"),
  Flag.optional,
);

export const t3Cli = Command.make("t3", {
  mode: modeFlag,
  port: portFlag,
  host: hostFlag,
  t3Home: t3HomeFlag,
  devUrl: devUrlFlag,
  noBrowser: noBrowserFlag,
  authToken: authTokenFlag,
  bootstrapFd: bootstrapFdFlag,
  autoBootstrapProjectFromCwd: autoBootstrapProjectFromCwdFlag,
  logWebSocketEvents: logWebSocketEventsFlag,
}).pipe(
  Command.withDescription("Run the T3 Code server."),
  Command.withHandler((input) => Effect.scoped(makeServerProgram(input))),
);
