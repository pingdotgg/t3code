import { NetService } from "@t3tools/shared/Net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Data, Effect, Layer, Option, Path, Schema } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import {
  DEFAULT_PORT,
  resolveStaticDir,
  ServerConfig,
  type RuntimeMode,
  type ServerConfigShape,
} from "./config";
import { fixPath, resolveStateDir } from "./os-jank";
import { runServer } from "./server";

export class StartupError extends Data.TaggedError("StartupError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

type CliBooleanFlag = "true" | "false";

const parseCliBoolean = (value: CliBooleanFlag): boolean => value === "true";

const resolveBooleanSetting = (
  value: Option.Option<CliBooleanFlag>,
  envValue: boolean | undefined,
  fallback: boolean,
): boolean =>
  Option.match(value, {
    onSome: parseCliBoolean,
    onNone: () => envValue ?? fallback,
  });

export interface CliInput {
  readonly mode: Option.Option<RuntimeMode>;
  readonly port: Option.Option<number>;
  readonly host: Option.Option<string>;
  readonly stateDir: Option.Option<string>;
  readonly devUrl: Option.Option<URL>;
  readonly noBrowser: Option.Option<CliBooleanFlag>;
  readonly authToken: Option.Option<string>;
  readonly autoBootstrapProjectFromCwd: Option.Option<CliBooleanFlag>;
  readonly logWebSocketEvents: Option.Option<CliBooleanFlag>;
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
  host: Config.string("T3CODE_HOST").pipe(Config.option, Config.map(Option.getOrUndefined)),
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
  autoBootstrapProjectFromCwd: Config.boolean("T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  logWebSocketEvents: Config.boolean("T3CODE_LOG_WS_EVENTS").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
});

export const resolveServerConfig = (input: CliInput) =>
  Effect.gen(function* () {
    const { findAvailablePort } = yield* NetService;
    const { join } = yield* Path.Path;

    yield* Effect.sync(fixPath);

    const env = yield* CliEnvConfig.asEffect().pipe(
      Effect.mapError(
        (cause) => new StartupError({ message: "Failed to read environment configuration", cause }),
      ),
    );

    const mode = Option.getOrElse(input.mode, () => env.mode);
    const port = yield* Option.match(input.port, {
      onSome: Effect.succeed,
      onNone: () => {
        if (env.port) {
          return Effect.succeed(env.port);
        }
        if (mode === "desktop") {
          return Effect.succeed(DEFAULT_PORT);
        }
        return findAvailablePort(DEFAULT_PORT);
      },
    });

    const stateDir = yield* resolveStateDir(Option.getOrUndefined(input.stateDir) ?? env.stateDir);
    const devUrl = Option.getOrElse(input.devUrl, () => env.devUrl);

    return {
      mode,
      port,
      cwd: process.cwd(),
      keybindingsConfigPath: join(stateDir, "keybindings.json"),
      host:
        Option.getOrUndefined(input.host) ??
        env.host ??
        (mode === "desktop" ? "127.0.0.1" : undefined),
      stateDir,
      staticDir: devUrl ? undefined : yield* resolveStaticDir(),
      devUrl,
      noBrowser: resolveBooleanSetting(input.noBrowser, env.noBrowser, mode === "desktop"),
      authToken: Option.getOrUndefined(input.authToken) ?? env.authToken,
      autoBootstrapProjectFromCwd: resolveBooleanSetting(
        input.autoBootstrapProjectFromCwd,
        env.autoBootstrapProjectFromCwd,
        mode === "web",
      ),
      logWebSocketEvents: resolveBooleanSetting(
        input.logWebSocketEvents,
        env.logWebSocketEvents,
        Boolean(devUrl),
      ),
    } satisfies ServerConfigShape;
  });

const modeFlag = Flag.choice("mode", ["web", "desktop"]).pipe(
  Flag.withDescription("Runtime mode. `desktop` keeps loopback defaults unless overridden."),
  Flag.optional,
);

const portFlag = Flag.integer("port").pipe(
  Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
  Flag.withDescription("Port for the HTTP/WebSocket server."),
  Flag.optional,
);

const hostFlag = Flag.string("host").pipe(
  Flag.withDescription("Host/interface to bind (for example 127.0.0.1, 0.0.0.0, or a Tailnet IP)."),
  Flag.optional,
);

const stateDirFlag = Flag.string("state-dir").pipe(
  Flag.withDescription("State directory path (equivalent to T3CODE_STATE_DIR)."),
  Flag.optional,
);

const devUrlFlag = Flag.string("dev-url").pipe(
  Flag.withSchema(Schema.URLFromString),
  Flag.withDescription("Dev web URL to proxy/redirect to (equivalent to VITE_DEV_SERVER_URL)."),
  Flag.optional,
);

const noBrowserFlag = Flag.choice("no-browser", ["true", "false"]).pipe(
  Flag.withDescription("Disable automatic browser opening (`true` or `false`)."),
  Flag.optional,
);

const authTokenFlag = Flag.string("auth-token").pipe(
  Flag.withDescription("Auth token required for WebSocket connections."),
  Flag.withAlias("token"),
  Flag.optional,
);

const autoBootstrapProjectFromCwdFlag = Flag.choice(
  "auto-bootstrap-project-from-cwd",
  ["true", "false"],
).pipe(
  Flag.withDescription(
    "Create a project for the current working directory on startup when missing (`true` or `false`).",
  ),
  Flag.optional,
);

const logWebSocketEventsFlag = Flag.choice("log-websocket-events", ["true", "false"]).pipe(
  Flag.withDescription(
    "Emit server-side logs for outbound WebSocket push traffic (`true` or `false`).",
  ),
  Flag.withAlias("log-ws-events"),
  Flag.optional,
);

export const t3Cli = Command.make("t3", {
  mode: modeFlag,
  port: portFlag,
  host: hostFlag,
  stateDir: stateDirFlag,
  devUrl: devUrlFlag,
  noBrowser: noBrowserFlag,
  authToken: authTokenFlag,
  autoBootstrapProjectFromCwd: autoBootstrapProjectFromCwdFlag,
  logWebSocketEvents: logWebSocketEventsFlag,
}).pipe(
  Command.withDescription("Run the T3 Code server."),
  Command.withHandler((input: CliInput) =>
    Effect.flatMap(resolveServerConfig(input), (config) =>
      runServer.pipe(Effect.provideService(ServerConfig, config)),
    ).pipe(Effect.provide(Layer.mergeAll(NetService.layer, NodeServices.layer))),
  ),
);
