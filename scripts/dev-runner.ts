#!/usr/bin/env node

import * as NodeOS from "node:os";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NetService } from "@harness/shared/Net";
import { Config, Data, Effect, Hash, Layer, Logger, Option, Path, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { ChildProcess } from "effect/unstable/process";

const BASE_SERVER_PORT = 13773;
const BASE_WEB_PORT = 5733;
const MAX_HASH_OFFSET = 3000;
const MAX_PORT = 65535;
const DESKTOP_DEV_LOOPBACK_HOST = "127.0.0.1";
const DEV_PORT_PROBE_HOSTS = ["127.0.0.1", "0.0.0.0", "::1", "::"] as const;

export const DEFAULT_HARNESS_HOME = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(NodeOS.homedir(), ".harness"),
);

const MODE_ARGS = {
  dev: [
    "run",
    "dev",
    "--ui=tui",
    "--filter=@harness/contracts",
    "--filter=@harness/web",
    "--filter=harness",
    "--parallel",
  ],
  "dev:server": ["run", "dev", "--filter=harness"],
  "dev:web": ["run", "dev", "--filter=@harness/web"],
  "dev:desktop": ["run", "dev", "--filter=@harness/desktop", "--filter=@harness/web", "--parallel"],
} as const satisfies Record<string, ReadonlyArray<string>>;

type DevMode = keyof typeof MODE_ARGS;
type PortAvailabilityCheck<R = never> = (port: number) => Effect.Effect<boolean, never, R>;

const DEV_RUNNER_MODES = Object.keys(MODE_ARGS) as Array<DevMode>;

class DevRunnerError extends Data.TaggedError("DevRunnerError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const optionalStringConfig = (name: string): Config.Config<string | undefined> =>
  Config.string(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const optionalBooleanConfig = (name: string): Config.Config<boolean | undefined> =>
  Config.boolean(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const optionalPortConfig = (name: string): Config.Config<number | undefined> =>
  Config.port(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const optionalIntegerConfig = (name: string): Config.Config<number | undefined> =>
  Config.int(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const optionalUrlConfig = (name: string): Config.Config<URL | undefined> =>
  Config.url(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );

const OffsetConfig = Config.all({
  portOffset: optionalIntegerConfig("HARNESS_PORT_OFFSET"),
  devInstance: optionalStringConfig("HARNESS_DEV_INSTANCE"),
});

export function resolveOffset(config: {
  readonly portOffset: number | undefined;
  readonly devInstance: string | undefined;
}): { readonly offset: number; readonly source: string } {
  if (config.portOffset !== undefined) {
    if (config.portOffset < 0) {
      throw new Error(`Invalid HARNESS_PORT_OFFSET: ${config.portOffset}`);
    }
    return {
      offset: config.portOffset,
      source: `HARNESS_PORT_OFFSET=${config.portOffset}`,
    };
  }

  const seed = config.devInstance?.trim();
  if (!seed) {
    return { offset: 0, source: "default ports" };
  }

  if (/^\d+$/.test(seed)) {
    return { offset: Number(seed), source: `numeric HARNESS_DEV_INSTANCE=${seed}` };
  }

  const offset = ((Hash.string(seed) >>> 0) % MAX_HASH_OFFSET) + 1;
  return { offset, source: `hashed HARNESS_DEV_INSTANCE=${seed}` };
}

function resolveBaseDir(baseDir: string | undefined): Effect.Effect<string, never, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const configured = baseDir?.trim();

    if (configured) {
      return path.resolve(configured);
    }

    return yield* DEFAULT_HARNESS_HOME;
  });
}

interface CreateDevRunnerEnvInput {
  readonly mode: DevMode;
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly serverOffset: number;
  readonly webOffset: number;
  readonly harnessHome: string | undefined;
  readonly noBrowser: boolean | undefined;
  readonly autoBootstrapProjectFromCwd: boolean | undefined;
  readonly logWebSocketEvents: boolean | undefined;
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly devUrl: URL | undefined;
}

export function createDevRunnerEnv({
  mode,
  baseEnv,
  serverOffset,
  webOffset,
  harnessHome,
  noBrowser,
  autoBootstrapProjectFromCwd,
  logWebSocketEvents,
  host,
  port,
  devUrl,
}: CreateDevRunnerEnvInput): Effect.Effect<NodeJS.ProcessEnv, never, Path.Path> {
  return Effect.gen(function* () {
    const serverPort = port ?? BASE_SERVER_PORT + serverOffset;
    const webPort = BASE_WEB_PORT + webOffset;
    const resolvedBaseDir = yield* resolveBaseDir(harnessHome);
    const isDesktopMode = mode === "dev:desktop";

    const output: NodeJS.ProcessEnv = {
      ...baseEnv,
      PORT: String(webPort),
      VITE_DEV_SERVER_URL:
        devUrl?.toString() ??
        `http://${isDesktopMode ? DESKTOP_DEV_LOOPBACK_HOST : "localhost"}:${webPort}`,
      HARNESS_HOME: resolvedBaseDir,
    };

    if (!isDesktopMode) {
      output.HARNESS_PORT = String(serverPort);
      output.VITE_HTTP_URL = `http://localhost:${serverPort}`;
      output.VITE_WS_URL = `ws://localhost:${serverPort}`;
    } else {
      output.HARNESS_PORT = String(serverPort);
      output.VITE_HTTP_URL = `http://${DESKTOP_DEV_LOOPBACK_HOST}:${serverPort}`;
      output.VITE_WS_URL = `ws://${DESKTOP_DEV_LOOPBACK_HOST}:${serverPort}`;
      delete output.HARNESS_MODE;
      delete output.HARNESS_NO_BROWSER;
      delete output.HARNESS_HOST;
    }

    if (!isDesktopMode && host !== undefined) {
      output.HARNESS_HOST = host;
    }

    if (!isDesktopMode && noBrowser !== undefined) {
      output.HARNESS_NO_BROWSER = noBrowser ? "1" : "0";
    } else if (!isDesktopMode) {
      delete output.HARNESS_NO_BROWSER;
    }

    if (autoBootstrapProjectFromCwd !== undefined) {
      output.HARNESS_AUTO_BOOTSTRAP_PROJECT_FROM_CWD = autoBootstrapProjectFromCwd ? "1" : "0";
    } else {
      delete output.HARNESS_AUTO_BOOTSTRAP_PROJECT_FROM_CWD;
    }

    if (logWebSocketEvents !== undefined) {
      output.HARNESS_LOG_WS_EVENTS = logWebSocketEvents ? "1" : "0";
    } else {
      delete output.HARNESS_LOG_WS_EVENTS;
    }

    if (mode === "dev") {
      output.HARNESS_MODE = "web";
      delete output.HARNESS_DESKTOP_WS_URL;
    }

    if (mode === "dev:server" || mode === "dev:web") {
      output.HARNESS_MODE = "web";
      delete output.HARNESS_DESKTOP_WS_URL;
    }

    if (isDesktopMode) {
      output.HOST = DESKTOP_DEV_LOOPBACK_HOST;
      delete output.HARNESS_DESKTOP_WS_URL;
      // Vite may start before Electron has spawned the backend; suppress noisy proxy ECONNREFUSED logs.
      output.HARNESS_DESKTOP_DEV = "1";
    }

    return output;
  });
}

function portPairForOffset(offset: number): {
  readonly serverPort: number;
  readonly webPort: number;
} {
  return {
    serverPort: BASE_SERVER_PORT + offset,
    webPort: BASE_WEB_PORT + offset,
  };
}

export function checkPortAvailabilityOnHosts<R>(
  port: number,
  hosts: ReadonlyArray<string>,
  canListenOnHost: (port: number, host: string) => Effect.Effect<boolean, never, R>,
): Effect.Effect<boolean, never, R> {
  return Effect.gen(function* () {
    for (const host of hosts) {
      if (!(yield* canListenOnHost(port, host))) {
        return false;
      }
    }

    return true;
  });
}

const defaultCheckPortAvailability: PortAvailabilityCheck<NetService> = (port) =>
  Effect.gen(function* () {
    const net = yield* NetService;
    return yield* checkPortAvailabilityOnHosts(port, DEV_PORT_PROBE_HOSTS, (candidatePort, host) =>
      net.canListenOnHost(candidatePort, host),
    );
  });

interface FindFirstAvailableOffsetInput<R = NetService> {
  readonly startOffset: number;
  readonly requireServerPort: boolean;
  readonly requireWebPort: boolean;
  readonly checkPortAvailability?: PortAvailabilityCheck<R>;
}

export function findFirstAvailableOffset<R = NetService>({
  startOffset,
  requireServerPort,
  requireWebPort,
  checkPortAvailability,
}: FindFirstAvailableOffsetInput<R>): Effect.Effect<number, DevRunnerError, R> {
  return Effect.gen(function* () {
    const checkPort = (checkPortAvailability ??
      defaultCheckPortAvailability) as PortAvailabilityCheck<R>;

    for (let candidate = startOffset; ; candidate += 1) {
      const { serverPort, webPort } = portPairForOffset(candidate);
      const serverPortOutOfRange = serverPort > MAX_PORT;
      const webPortOutOfRange = webPort > MAX_PORT;

      if (
        (requireServerPort && serverPortOutOfRange) ||
        (requireWebPort && webPortOutOfRange) ||
        (!requireServerPort && !requireWebPort && (serverPortOutOfRange || webPortOutOfRange))
      ) {
        break;
      }

      const checks: Array<Effect.Effect<boolean, never, R>> = [];
      if (requireServerPort) {
        checks.push(checkPort(serverPort));
      }
      if (requireWebPort) {
        checks.push(checkPort(webPort));
      }

      if (checks.length === 0) {
        return candidate;
      }

      const availability = yield* Effect.all(checks);
      if (availability.every(Boolean)) {
        return candidate;
      }
    }

    return yield* new DevRunnerError({
      message: `No available dev ports found from offset ${startOffset}. Tried server=${BASE_SERVER_PORT}+n web=${BASE_WEB_PORT}+n up to port ${MAX_PORT}.`,
    });
  });
}

interface ResolveModePortOffsetsInput<R = NetService> {
  readonly mode: DevMode;
  readonly startOffset: number;
  readonly hasExplicitServerPort: boolean;
  readonly hasExplicitDevUrl: boolean;
  readonly checkPortAvailability?: PortAvailabilityCheck<R>;
}

export function resolveModePortOffsets<R = NetService>({
  mode,
  startOffset,
  hasExplicitServerPort,
  hasExplicitDevUrl,
  checkPortAvailability,
}: ResolveModePortOffsetsInput<R>): Effect.Effect<
  { readonly serverOffset: number; readonly webOffset: number },
  DevRunnerError,
  R
> {
  return Effect.gen(function* () {
    const checkPort = (checkPortAvailability ??
      defaultCheckPortAvailability) as PortAvailabilityCheck<R>;

    if (mode === "dev:web") {
      if (hasExplicitDevUrl) {
        return { serverOffset: startOffset, webOffset: startOffset };
      }

      const webOffset = yield* findFirstAvailableOffset({
        startOffset,
        requireServerPort: false,
        requireWebPort: true,
        checkPortAvailability: checkPort,
      });
      return { serverOffset: startOffset, webOffset };
    }

    if (mode === "dev:server") {
      if (hasExplicitServerPort) {
        return { serverOffset: startOffset, webOffset: startOffset };
      }

      const serverOffset = yield* findFirstAvailableOffset({
        startOffset,
        requireServerPort: true,
        requireWebPort: false,
        checkPortAvailability: checkPort,
      });
      return { serverOffset, webOffset: serverOffset };
    }

    const sharedOffset = yield* findFirstAvailableOffset({
      startOffset,
      requireServerPort: !hasExplicitServerPort,
      requireWebPort: !hasExplicitDevUrl,
      checkPortAvailability: checkPort,
    });

    return { serverOffset: sharedOffset, webOffset: sharedOffset };
  });
}

interface DevRunnerCliInput {
  readonly mode: DevMode;
  readonly harnessHome: string | undefined;
  readonly noBrowser: boolean | undefined;
  readonly autoBootstrapProjectFromCwd: boolean | undefined;
  readonly logWebSocketEvents: boolean | undefined;
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly devUrl: URL | undefined;
  readonly dryRun: boolean;
  readonly turboArgs: ReadonlyArray<string>;
}

export function runDevRunnerWithInput(input: DevRunnerCliInput) {
  return Effect.gen(function* () {
    const { portOffset, devInstance } = yield* OffsetConfig.asEffect().pipe(
      Effect.mapError(
        (cause) =>
          new DevRunnerError({
            message: "Failed to read HARNESS_PORT_OFFSET/HARNESS_DEV_INSTANCE configuration.",
            cause,
          }),
      ),
    );

    const { offset, source } = yield* Effect.try({
      try: () => resolveOffset({ portOffset, devInstance }),
      catch: (cause) =>
        new DevRunnerError({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });

    const { serverOffset, webOffset } = yield* resolveModePortOffsets({
      mode: input.mode,
      startOffset: offset,
      hasExplicitServerPort: input.port !== undefined,
      hasExplicitDevUrl: input.devUrl !== undefined,
    });

    const env = yield* createDevRunnerEnv({
      mode: input.mode,
      baseEnv: process.env,
      serverOffset,
      webOffset,
      harnessHome: input.harnessHome,
      noBrowser: input.noBrowser,
      autoBootstrapProjectFromCwd: input.autoBootstrapProjectFromCwd,
      logWebSocketEvents: input.logWebSocketEvents,
      host: input.host,
      port: input.port,
      devUrl: input.devUrl,
    });

    const selectionSuffix =
      serverOffset !== offset || webOffset !== offset
        ? ` selectedOffset(server=${serverOffset},web=${webOffset})`
        : "";

    yield* Effect.logInfo(
      `[dev-runner] mode=${input.mode} source=${source}${selectionSuffix} serverPort=${String(env.HARNESS_PORT)} webPort=${String(env.PORT)} baseDir=${String(env.HARNESS_HOME)}`,
    );

    if (input.dryRun) {
      return;
    }

    const child = yield* ChildProcess.make(
      "turbo",
      [...MODE_ARGS[input.mode], ...input.turboArgs],
      {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env,
        extendEnv: false,
        // Windows needs shell mode to resolve .cmd shims (e.g. bun.cmd).
        shell: process.platform === "win32",
        // Keep turbo in the same process group so terminal signals (Ctrl+C)
        // reach it directly. Effect defaults to detached: true on non-Windows,
        // which would put turbo in a new group and require manual forwarding.
        detached: false,
        forceKillAfter: "1500 millis",
      },
    );

    const exitCode = yield* child.exitCode;
    if (exitCode !== 0) {
      return yield* new DevRunnerError({
        message: `turbo exited with code ${exitCode}`,
      });
    }
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof DevRunnerError
        ? cause
        : new DevRunnerError({
            message: cause instanceof Error ? cause.message : "dev-runner failed",
            cause,
          }),
    ),
  );
}

const devRunnerCli = Command.make("dev-runner", {
  mode: Argument.choice("mode", DEV_RUNNER_MODES).pipe(
    Argument.withDescription("Development mode to run."),
  ),
  harnessHome: Flag.string("home-dir").pipe(
    Flag.withDescription("Base directory for all Harness data (equivalent to HARNESS_HOME)."),
    Flag.withFallbackConfig(optionalStringConfig("HARNESS_HOME")),
  ),
  noBrowser: Flag.boolean("no-browser").pipe(
    Flag.withDescription("Browser auto-open toggle (equivalent to HARNESS_NO_BROWSER)."),
    Flag.withFallbackConfig(optionalBooleanConfig("HARNESS_NO_BROWSER")),
  ),
  autoBootstrapProjectFromCwd: Flag.boolean("auto-bootstrap-project-from-cwd").pipe(
    Flag.withDescription(
      "Auto-bootstrap toggle (equivalent to HARNESS_AUTO_BOOTSTRAP_PROJECT_FROM_CWD).",
    ),
    Flag.withFallbackConfig(optionalBooleanConfig("HARNESS_AUTO_BOOTSTRAP_PROJECT_FROM_CWD")),
  ),
  logWebSocketEvents: Flag.boolean("log-websocket-events").pipe(
    Flag.withDescription("WebSocket event logging toggle (equivalent to HARNESS_LOG_WS_EVENTS)."),
    Flag.withAlias("log-ws-events"),
    Flag.withFallbackConfig(optionalBooleanConfig("HARNESS_LOG_WS_EVENTS")),
  ),
  host: Flag.string("host").pipe(
    Flag.withDescription("Server host/interface override (forwards to HARNESS_HOST)."),
    Flag.withFallbackConfig(optionalStringConfig("HARNESS_HOST")),
  ),
  port: Flag.integer("port").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
    Flag.withDescription("Server port override (forwards to HARNESS_PORT)."),
    Flag.withFallbackConfig(optionalPortConfig("HARNESS_PORT")),
  ),
  devUrl: Flag.string("dev-url").pipe(
    Flag.withSchema(Schema.URLFromString),
    Flag.withDescription("Web dev URL override (forwards to VITE_DEV_SERVER_URL)."),
    Flag.withFallbackConfig(optionalUrlConfig("VITE_DEV_SERVER_URL")),
  ),
  dryRun: Flag.boolean("dry-run").pipe(
    Flag.withDescription("Resolve mode/ports/env and print, but do not spawn turbo."),
    Flag.withDefault(false),
  ),
  turboArgs: Argument.string("turbo-arg").pipe(
    Argument.withDescription("Additional turbo args (pass after `--`)."),
    Argument.variadic(),
  ),
}).pipe(
  Command.withDescription("Run monorepo development modes with deterministic port/env wiring."),
  Command.withHandler((input) => runDevRunnerWithInput(input)),
);

const cliRuntimeLayer = Layer.mergeAll(
  Logger.layer([Logger.consolePretty()]),
  NodeServices.layer,
  NetService.layer,
);

if (import.meta.main) {
  Command.run(devRunnerCli, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(cliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
