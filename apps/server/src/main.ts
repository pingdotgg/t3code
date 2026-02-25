import { Config, Data, Effect, FileSystem, Layer, Option, Path, Schema, ServiceMap } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import {
  DEFAULT_PORT,
  NetService,
  resolveStaticDir,
  ServerConfig,
  type RuntimeMode,
  type ServerConfigShape,
} from "./config";
import { fixPath, resolveStateDir } from "./os-jank";
import { Open } from "./open";
import * as SqlitePersistence from "./persistence/Layers/Sqlite";
import { makeServerProviderLayer, makeServerRuntimeServicesLayer } from "./serverLayers";
import { Server } from "./wsServer";

export class StartupError extends Data.TaggedError("StartupError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface CliInput {
  readonly port: Option.Option<number>;
  readonly token: Option.Option<string>;
}

export interface CliConfigShape {
  readonly cwd: string;
  readonly fixPath: Effect.Effect<void>;
  readonly resolveStaticDir: Effect.Effect<string | undefined>;
}

export class CliConfig extends ServiceMap.Service<CliConfig, CliConfigShape>()("server/CliConfig") {
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
    Config.map(
      Option.match<RuntimeMode, string>({
        onNone: () => "web",
        onSome: (value) => (value === "desktop" ? "desktop" : "web"),
      }),
    ),
  ),
  port: Config.port("T3CODE_PORT").pipe(Config.option, Config.map(Option.getOrUndefined)),
  stateDir: Config.string("T3CODE_STATE_DIR").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  devUrl: Config.url("VITE_DEV_SERVER_URL").pipe(Config.option, Config.map(Option.getOrUndefined)),
  noBrowser: Config.boolean("T3CODE_NO_BROWSER").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  authToken: Config.string("T3CODE_AUTH_TOKEN").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
});

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

      const port = yield* Option.match(input.port, {
        onSome: (value) => Effect.succeed(value),
        onNone: () => {
          if (env.port) {
            return Effect.succeed(env.port);
          }
          if (env.mode === "desktop") {
            return Effect.succeed(DEFAULT_PORT);
          }
          return findAvailablePort(DEFAULT_PORT);
        },
      });
      const stateDir = yield* resolveStateDir(env.stateDir);
      const devUrl = env.devUrl;
      const noBrowser = env.noBrowser ?? env.mode === "desktop";
      const authToken = Option.getOrUndefined(input.token) ?? env.authToken;
      const staticDir = devUrl ? undefined : yield* cliConfig.resolveStaticDir;
      const host = env.mode === "desktop" ? "127.0.0.1" : undefined;

      return {
        mode: env.mode,
        port,
        cwd: cliConfig.cwd,
        host,
        stateDir,
        staticDir,
        devUrl,
        noBrowser,
        authToken,
      } satisfies ServerConfigShape;
    }),
  );

const LayerLive = (input: CliInput) =>
  Layer.empty.pipe(
    Layer.provideMerge(makeServerRuntimeServicesLayer()),
    Layer.provideMerge(makeServerProviderLayer()),
    Layer.provideMerge(SqlitePersistence.layerConfig),
    Layer.provideMerge(ServerConfigLive(input)),
  );

const makeServerProgram = (input: CliInput) =>
  Effect.gen(function* () {
    const cliConfig = yield* CliConfig;
    const { createServer, stopSignal } = yield* Server;
    const openDeps = yield* Open;
    yield* cliConfig.fixPath;

    const config = yield* ServerConfig;

    if (!config.devUrl && !config.staticDir) {
      yield* Effect.logWarning(
        "web bundle missing and no VITE_DEV_SERVER_URL; web UI unavailable",
        {
          hint: "Run `bun run --cwd apps/web build` or set VITE_DEV_SERVER_URL for dev mode.",
        },
      );
    }

    yield* createServer();

    const url = `http://localhost:${config.port}`;
    yield* Effect.logInfo("T3 Code running", {
      url,
      cwd: config.cwd,
      mode: config.mode,
      stateDir: config.stateDir,
      authEnabled: Boolean(config.authToken),
    });

    if (!config.noBrowser) {
      const target = config.devUrl?.toString() ?? url;
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

export function makeCliCommand() {
  const portFlag = Flag.integer("port").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
    Flag.withDescription("Port for the HTTP/WebSocket server."),
    Flag.optional,
  );
  const tokenFlag = Flag.string("token").pipe(
    Flag.withDescription("Auth token required for WebSocket connections."),
    Flag.optional,
  );

  return Command.make("t3", {
    port: portFlag,
    token: tokenFlag,
  }).pipe(
    Command.withDescription("Run the T3 Code server."),
    Command.withHandler((input) => Effect.scoped(makeServerProgram(input))),
  );
}
