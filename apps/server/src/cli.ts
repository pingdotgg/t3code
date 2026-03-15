import { NetService } from "@t3tools/shared/Net";
import { Config, Effect, LogLevel, Option, Path, Schema } from "effect";
import { Command, Flag, GlobalFlag } from "effect/unstable/cli";

import {
  DEFAULT_PORT,
  resolveStaticDir,
  ServerConfig,
  type RuntimeMode,
  type ServerConfigShape,
} from "./config";
import { resolveStateDir } from "./os-jank";
import { runServer } from "./server";

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
const noBrowserFlag = Flag.boolean("no-browser").pipe(
  Flag.withDescription("Disable automatic browser opening."),
  Flag.optional,
);
const authTokenFlag = Flag.string("auth-token").pipe(
  Flag.withDescription("Auth token required for WebSocket connections."),
  Flag.withAlias("token"),
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

const EnvServerConfig = Config.all({
  logLevel: Config.logLevel("T3CODE_LOG_LEVEL").pipe(Config.withDefault("Info")),
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

interface CliServerFlags {
  readonly mode: Option.Option<RuntimeMode>;
  readonly port: Option.Option<number>;
  readonly host: Option.Option<string>;
  readonly stateDir: Option.Option<string>;
  readonly devUrl: Option.Option<URL>;
  readonly noBrowser: Option.Option<boolean>;
  readonly authToken: Option.Option<string>;
  readonly autoBootstrapProjectFromCwd: Option.Option<boolean>;
  readonly logWebSocketEvents: Option.Option<boolean>;
}

const resolveBooleanFlag = (flag: Option.Option<boolean>, envValue: boolean) =>
  Option.getOrElse(Option.filter(flag, Boolean), () => envValue);

export const resolveServerConfig = (
  flags: CliServerFlags,
  cliLogLevel: Option.Option<LogLevel.LogLevel>,
) =>
  Effect.gen(function* () {
    const { findAvailablePort } = yield* NetService;
    const env = yield* EnvServerConfig;

    const mode = Option.getOrElse(flags.mode, () => env.mode);

    const port = yield* Option.match(flags.port, {
      onSome: (value) => Effect.succeed(value),
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
    const stateDir = yield* resolveStateDir(Option.getOrUndefined(flags.stateDir) ?? env.stateDir);
    const devUrl = Option.getOrElse(flags.devUrl, () => env.devUrl);
    const noBrowser = resolveBooleanFlag(flags.noBrowser, env.noBrowser ?? mode === "desktop");
    const authToken = Option.getOrUndefined(flags.authToken) ?? env.authToken;
    const autoBootstrapProjectFromCwd = resolveBooleanFlag(
      flags.autoBootstrapProjectFromCwd,
      env.autoBootstrapProjectFromCwd ?? mode === "web",
    );
    const logWebSocketEvents = resolveBooleanFlag(
      flags.logWebSocketEvents,
      env.logWebSocketEvents ?? Boolean(devUrl),
    );
    const staticDir = devUrl ? undefined : yield* resolveStaticDir();
    const { join } = yield* Path.Path;
    const keybindingsConfigPath = join(stateDir, "keybindings.json");
    const host =
      Option.getOrUndefined(flags.host) ??
      env.host ??
      (mode === "desktop" ? "127.0.0.1" : undefined);
    const logLevel = Option.getOrElse(cliLogLevel, () => env.logLevel);

    const config: ServerConfigShape = {
      logLevel,
      mode,
      port,
      cwd: process.cwd(),
      keybindingsConfigPath,
      host,
      stateDir,
      staticDir,
      devUrl,
      noBrowser,
      authToken,
      autoBootstrapProjectFromCwd,
      logWebSocketEvents,
    };

    return config;
  });

const commandFlags = {
  mode: modeFlag,
  port: portFlag,
  host: hostFlag,
  stateDir: stateDirFlag,
  devUrl: devUrlFlag,
  noBrowser: noBrowserFlag,
  authToken: authTokenFlag,
  autoBootstrapProjectFromCwd: autoBootstrapProjectFromCwdFlag,
  logWebSocketEvents: logWebSocketEventsFlag,
} as const;

const rootCommand = Command.make("t3", commandFlags).pipe(
  Command.withDescription("Run the T3 Code server."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveServerConfig(flags, logLevel);
      return yield* runServer.pipe(Effect.provideService(ServerConfig, config));
    }),
  ),
);

const resetCommand = Command.make("reset", {}).pipe(
  Command.withDescription("Reset the T3 Code server."),
  Command.withHandler(() => Effect.die("Not implemented")),
);

export const cli = rootCommand.pipe(Command.withSubcommands([resetCommand]));
