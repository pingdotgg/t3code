import net from "node:net";
import os from "node:os";

import {
  ServiceMap,
  Data,
  Effect,
  Layer,
  Option,
  Config,
  Path,
  Schema,
  FileSystem,
  PlatformError,
} from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { fixPath } from "./fixPath";
import { Open } from "./open";
import { Server } from "./wsServer";

const DEFAULT_PORT = 3773;

type RuntimeMode = "web" | "desktop";

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
  readonly fixPath: Effect.Effect<unknown, never>;
  readonly findAvailablePort: (preferred: number) => Effect.Effect<number, StartupError>;
  readonly resolveStaticDir: () => Effect.Effect<string | undefined, PlatformError.PlatformError>;
}

export class CliConfig extends ServiceMap.Service<CliConfig, CliConfigShape>()(
  "server/CliConfig",
) {}

const CliEnvConfig = Config.all({
  mode: Config.string("T3CODE_MODE").pipe(
    Config.option,
    Config.map(
      Option.match({
        onNone: () => "web" as const,
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

const expandHomePath = Effect.fn(function* (input: string) {
  const { join } = yield* Path.Path;
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) {
    return join(os.homedir(), input.slice(2));
  }
  return input;
});

const resolveStateDir = Effect.fn(function* (raw: string | undefined) {
  const { join, resolve } = yield* Path.Path;
  if (!raw || raw.trim().length === 0) {
    return join(os.homedir(), ".t3", "userdata");
  }
  return resolve(yield* expandHomePath(raw.trim()));
});

async function findAvailablePort(preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(preferred, () => {
      server.close(() => resolve(preferred));
    });
    server.on("error", () => {
      const fallback = net.createServer();
      fallback.listen(0, () => {
        const addr = fallback.address();
        const port = typeof addr === "object" && addr !== null ? addr.port : 0;
        fallback.close(() => {
          if (port > 0) resolve(port);
          else reject(new Error("Could not find an available port."));
        });
      });
      fallback.on("error", reject);
    });
  });
}

const resolveStaticDir = Effect.fn(function* () {
  const { join, resolve } = yield* Path.Path;
  const { stat } = yield* FileSystem.FileSystem;
  const bundledClient = resolve(join(import.meta.dirname, "client"));
  const bundledStat = yield* stat(join(bundledClient, "index.html")).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  if (bundledStat) return bundledClient;

  const monorepoClient = resolve(join(import.meta.dirname, "../../web/dist"));
  const monorepoStat = yield* stat(join(monorepoClient, "index.html")).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  if (monorepoStat) return monorepoClient;
  return undefined;
});

const resolveCliConfig = Effect.fn(function* (input: CliInput) {
  const cliConfig = yield* CliConfig;
  const env = yield* CliEnvConfig.asEffect().pipe(
    Effect.mapError(
      (cause) =>
        new StartupError({
          message: "Failed to read environment configuration",
          cause,
        }),
    ),
  );
  const mode: RuntimeMode = env.mode === "desktop" ? "desktop" : "web";

  const cliPort = Option.getOrUndefined(input.port);
  const port =
    (cliPort === undefined ? env.port : cliPort) ??
    (mode === "desktop" ? DEFAULT_PORT : yield* cliConfig.findAvailablePort(DEFAULT_PORT));
  const stateDir = yield* resolveStateDir(env.stateDir);
  const devUrl = env.devUrl;
  const noBrowser = env.noBrowser ?? mode === "desktop";
  const authToken = Option.getOrUndefined(input.token) ?? env.authToken;
  const staticDir = devUrl ? undefined : yield* cliConfig.resolveStaticDir();

  return {
    mode,
    port,
    stateDir,
    devUrl,
    noBrowser,
    authToken,
    staticDir,
    cwd: cliConfig.cwd,
  };
});

const makeServerProgram = Effect.fn(function* (input: CliInput) {
  const cliConfig = yield* CliConfig;
  const serverDeps = yield* Server;
  const openDeps = yield* Open;
  yield* cliConfig.fixPath;
  const config = yield* resolveCliConfig(input);

  if (!config.devUrl && !config.staticDir) {
    yield* Effect.logWarning("web bundle missing and no VITE_DEV_SERVER_URL; web UI unavailable", {
      hint: "Run `bun run --cwd apps/web build` or set VITE_DEV_SERVER_URL for dev mode.",
    });
  }

  yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const server = serverDeps.createServer({
          port: config.port,
          host: config.mode === "desktop" ? "127.0.0.1" : undefined,
          cwd: config.cwd,
          autoBootstrapProjectFromCwd: config.mode === "web",
          stateDir: config.stateDir,
          staticDir: config.staticDir,
          devUrl: config.devUrl?.href,
          authToken: config.authToken,
        });
        await server.start();
        return server;
      },
      catch: (cause) => new StartupError({ message: "Failed to start server", cause }),
    }),
    (server) =>
      Effect.tryPromise({
        try: () => server.stop(),
        catch: (cause) => new StartupError({ message: "Failed to stop server", cause }),
      }).pipe(Effect.catch((error) => Effect.logError("failed to stop server cleanly", { error }))),
  );

  const url = `http://localhost:${config.port}`;
  yield* Effect.logInfo("T3 Code running", {
    url,
    cwd: config.cwd,
    mode: config.mode,
    stateDir: config.stateDir,
    authEnabled: Boolean(config.authToken),
  });

  if (!config.noBrowser) {
    const target = config.devUrl ?? url;
    yield* openDeps.openBrowser(target.toString()).pipe(
      Effect.catch(() =>
        Effect.logInfo("browser auto-open unavailable", {
          hint: `Open ${target} in your browser.`,
        }),
      ),
    );
  }

  return yield* Effect.never;
}, Effect.scoped);

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
    Command.withHandler((input) => makeServerProgram(input)),
  );
}

export const CliConfigLive = Layer.effect(
  CliConfig,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return {
      cwd: process.cwd(),
      fixPath: Effect.sync(fixPath),
      findAvailablePort: (preferred) =>
        Effect.tryPromise({
          try: () => findAvailablePort(preferred),
          catch: (cause) =>
            new StartupError({ message: "Failed to discover an available port", cause }),
        }),
      resolveStaticDir: () =>
        resolveStaticDir().pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
    } satisfies CliConfigShape;
  }),
);
