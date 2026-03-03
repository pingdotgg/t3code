#!/usr/bin/env node

import { homedir } from "node:os";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NetService } from "@t3tools/shared/Net";
import { Data, Effect, Layer, Logger, Option, Path } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { ChildProcess } from "effect/unstable/process";

const BASE_SERVER_PORT = 3773;
const BASE_WEB_PORT = 5733;
const MAX_HASH_OFFSET = 3000;
const MAX_PORT = 65535;

export const DEFAULT_DEV_STATE_DIR: Effect.Effect<string, never, Path.Path> = Effect.gen(
  function* () {
  const path = yield* Path.Path;
  return path.join(homedir(), ".t3", "dev");
});

const MODE_ARGS = {
  dev: [
    "run",
    "dev",
    "--ui=tui",
    "--filter=@t3tools/contracts",
    "--filter=@t3tools/web",
    "--filter=t3",
    "--parallel",
  ],
  "dev:server": ["run", "dev", "--filter=t3"],
  "dev:web": ["run", "dev", "--filter=@t3tools/web"],
  "dev:desktop": ["run", "dev", "--filter=@t3tools/desktop", "--filter=@t3tools/web", "--parallel"],
} as const satisfies Record<string, ReadonlyArray<string>>;

type DevMode = keyof typeof MODE_ARGS;
type EnvOverrides = Record<string, string>;
type PortAvailabilityCheck<R = never> = (port: number) => Effect.Effect<boolean, never, R>;

const DEV_RUNNER_MODES = Object.keys(MODE_ARGS) as Array<DevMode>;

class DevRunnerError extends Data.TaggedError("DevRunnerError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

function parseInteger(value: string, envName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid ${envName}: ${value}`);
  }
  return parsed;
}

function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function resolveOffset(env: NodeJS.ProcessEnv = process.env): {
  readonly offset: number;
  readonly source: string;
} {
  const explicitOffset = env.T3CODE_PORT_OFFSET?.trim();
  if (explicitOffset) {
    const parsed = parseInteger(explicitOffset, "T3CODE_PORT_OFFSET");
    if (parsed < 0) {
      throw new Error(`Invalid T3CODE_PORT_OFFSET: ${explicitOffset}`);
    }
    return { offset: parsed, source: `T3CODE_PORT_OFFSET=${explicitOffset}` };
  }

  const seed = env.T3CODE_DEV_INSTANCE?.trim();
  if (!seed) {
    return { offset: 0, source: "default ports" };
  }

  if (/^\d+$/.test(seed)) {
    return { offset: Number(seed), source: `numeric T3CODE_DEV_INSTANCE=${seed}` };
  }

  const offset = (hashSeed(seed) % MAX_HASH_OFFSET) + 1;
  return { offset, source: `hashed T3CODE_DEV_INSTANCE=${seed}` };
}

function toBooleanEnvValue(value: string | undefined): string {
  if (value === undefined) return "1";
  const normalized = value.trim().toLowerCase();
  if (normalized === "false" || normalized === "0" || normalized === "no") return "0";
  return "1";
}

function resolveStateDir(
  env: NodeJS.ProcessEnv,
  envOverrides: EnvOverrides,
): Effect.Effect<string, never, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const overrideValue = envOverrides?.T3CODE_STATE_DIR?.trim();
    if (overrideValue) {
      // Resolve relative paths against cwd (monorepo root) before turbo changes directories.
      return path.resolve(overrideValue);
    }

    const envValue = env?.T3CODE_STATE_DIR?.trim();
    if (envValue) {
      return path.resolve(envValue);
    }

    return yield* DEFAULT_DEV_STATE_DIR;
  });
}

interface CreateDevRunnerEnvInput {
  readonly mode: DevMode;
  readonly env: NodeJS.ProcessEnv;
  readonly offset: number;
  readonly envOverrides: EnvOverrides;
}

export function createDevRunnerEnv({
  mode,
  env,
  offset,
  envOverrides,
}: CreateDevRunnerEnvInput): Effect.Effect<NodeJS.ProcessEnv, DevRunnerError, Path.Path> {
  return Effect.gen(function* () {
    const serverPort = BASE_SERVER_PORT + offset;
    const webPort = BASE_WEB_PORT + offset;

    const output: NodeJS.ProcessEnv = {
      ...env,
      T3CODE_PORT: String(serverPort),
      PORT: String(webPort),
      ELECTRON_RENDERER_PORT: String(webPort),
      VITE_WS_URL: `ws://localhost:${serverPort}`,
      VITE_DEV_SERVER_URL: `http://localhost:${webPort}`,
      ...envOverrides,
    };

    output.T3CODE_STATE_DIR = yield* resolveStateDir(env, envOverrides);

    const parsedServerPort = yield* Effect.try({
      try: () => {
        const parsed = Number(output.T3CODE_PORT);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PORT) {
          throw new Error(
            `Invalid T3CODE_PORT override: '${String(output.T3CODE_PORT)}'. Expected an integer between 1 and 65535.`,
          );
        }
        return parsed;
      },
      catch: (cause) =>
        new DevRunnerError({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });
    output.VITE_WS_URL = `ws://localhost:${parsedServerPort}`;

    if (mode === "dev" || mode === "dev:server" || mode === "dev:web") {
      // Running server/web in browser mode should not inherit desktop launcher state.
      output.T3CODE_MODE = "web";
      if (!("T3CODE_NO_BROWSER" in envOverrides)) {
        delete output.T3CODE_NO_BROWSER;
      }
      if (!("T3CODE_AUTH_TOKEN" in envOverrides)) {
        delete output.T3CODE_AUTH_TOKEN;
      }
      delete output.T3CODE_DESKTOP_WS_URL;
    }

    if (mode === "dev" && !output.T3CODE_LOG_WS_EVENTS) {
      output.T3CODE_LOG_WS_EVENTS = "1";
    }

    return output;
  });
}

function portPairForOffset(offset: number): { readonly serverPort: number; readonly webPort: number } {
  return {
    serverPort: BASE_SERVER_PORT + offset,
    webPort: BASE_WEB_PORT + offset,
  };
}

const defaultCheckPortAvailability: PortAvailabilityCheck<NetService> = (port) =>
  Effect.gen(function* () {
    const net = yield* NetService;
    return yield* net.isPortAvailableOnLoopback(port);
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
    const checkPort = (checkPortAvailability ?? defaultCheckPortAvailability) as PortAvailabilityCheck<R>;
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
  readonly envOverrides: EnvOverrides;
  readonly checkPortAvailability?: PortAvailabilityCheck<R>;
}

export function resolveModePortOffsets<R = NetService>({
  mode,
  startOffset,
  envOverrides,
  checkPortAvailability,
}: ResolveModePortOffsetsInput<R>): Effect.Effect<
  { readonly serverOffset: number; readonly webOffset: number },
  DevRunnerError,
  R
> {
  return Effect.gen(function* () {
    const checkPort = (checkPortAvailability ?? defaultCheckPortAvailability) as PortAvailabilityCheck<R>;
    const hasExplicitServerPort = typeof envOverrides.T3CODE_PORT === "string";
    const hasExplicitDevUrl = typeof envOverrides.VITE_DEV_SERVER_URL === "string";

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

const optionValue = <A>(option: Option.Option<A>): A | undefined =>
  Option.isSome(option) ? option.value : undefined;

interface DevRunnerCliInput {
  readonly mode: DevMode;
  readonly stateDir: Option.Option<string>;
  readonly authToken: Option.Option<string>;
  readonly noBrowser: Option.Option<string>;
  readonly autoBootstrapProjectFromCwd: Option.Option<string>;
  readonly logWebSocketEvents: Option.Option<string>;
  readonly host: Option.Option<string>;
  readonly port: Option.Option<string>;
  readonly devUrl: Option.Option<string>;
  readonly dryRun: boolean;
  readonly turboArgs: ReadonlyArray<string>;
}

function envOverridesFromCliInput(input: DevRunnerCliInput): EnvOverrides {
  const envOverrides: EnvOverrides = {};

  const stateDir = optionValue(input.stateDir);
  if (stateDir !== undefined) envOverrides.T3CODE_STATE_DIR = stateDir;

  const authToken = optionValue(input.authToken);
  if (authToken !== undefined) envOverrides.T3CODE_AUTH_TOKEN = authToken;

  const host = optionValue(input.host);
  if (host !== undefined) envOverrides.T3CODE_HOST = host;

  const port = optionValue(input.port);
  if (port !== undefined) envOverrides.T3CODE_PORT = port;

  const devUrl = optionValue(input.devUrl);
  if (devUrl !== undefined) envOverrides.VITE_DEV_SERVER_URL = devUrl;

  const noBrowser = optionValue(input.noBrowser);
  if (noBrowser !== undefined) {
    envOverrides.T3CODE_NO_BROWSER = toBooleanEnvValue(noBrowser);
  }

  const autoBootstrapProjectFromCwd = optionValue(input.autoBootstrapProjectFromCwd);
  if (autoBootstrapProjectFromCwd !== undefined) {
    envOverrides.T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD = toBooleanEnvValue(
      autoBootstrapProjectFromCwd,
    );
  }

  const logWebSocketEvents = optionValue(input.logWebSocketEvents);
  if (logWebSocketEvents !== undefined) {
    envOverrides.T3CODE_LOG_WS_EVENTS = toBooleanEnvValue(logWebSocketEvents);
  }

  return envOverrides;
}

export function runDevRunnerWithInput(input: DevRunnerCliInput) {
  return Effect.gen(function* () {
    const envOverrides = envOverridesFromCliInput(input);
    const turboArgs = Array.from(input.turboArgs);
    const { offset, source } = yield* Effect.try({
      try: () => resolveOffset(),
      catch: (cause) =>
        new DevRunnerError({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });

    const { serverOffset, webOffset } = yield* resolveModePortOffsets({
      mode: input.mode,
      startOffset: offset,
      envOverrides,
    });

    const mergedEnvOverrides = { ...envOverrides };
    if (!("VITE_DEV_SERVER_URL" in mergedEnvOverrides)) {
      const { webPort } = portPairForOffset(webOffset);
      mergedEnvOverrides.PORT = String(webPort);
      mergedEnvOverrides.ELECTRON_RENDERER_PORT = String(webPort);
      mergedEnvOverrides.VITE_DEV_SERVER_URL = `http://localhost:${webPort}`;
    }

    const env = yield* createDevRunnerEnv({
      mode: input.mode,
      env: process.env,
      offset: serverOffset,
      envOverrides: mergedEnvOverrides,
    });

    const parsedServerPort = Number(env.T3CODE_PORT);
    const parsedWebPort = Number(env.PORT);
    if (
      !Number.isInteger(parsedServerPort) ||
      parsedServerPort < 1 ||
      parsedServerPort > MAX_PORT ||
      !Number.isInteger(parsedWebPort) ||
      parsedWebPort < 1 ||
      parsedWebPort > MAX_PORT
    ) {
      return yield* new DevRunnerError({
        message: `Invalid computed dev ports: server='${String(env.T3CODE_PORT)}' web='${String(env.PORT)}'.`,
      });
    }

    const selectionSuffix =
      serverOffset !== offset || webOffset !== offset
        ? ` selectedOffset(server=${serverOffset},web=${webOffset})`
        : "";

    yield* Effect.logInfo(
      `[dev-runner] mode=${input.mode} source=${source}${selectionSuffix} serverPort=${parsedServerPort} webPort=${parsedWebPort} stateDir=${String(env.T3CODE_STATE_DIR)}`,
    );

    if (input.dryRun) {
      return;
    }

    const command = process.platform === "win32" ? "turbo.cmd" : "turbo";
    const child = yield* ChildProcess.make(command, [...MODE_ARGS[input.mode], ...turboArgs], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env,
      extendEnv: false,
    });

    const exitCode = Number(yield* child.exitCode);
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
  stateDir: Flag.string("state-dir").pipe(
    Flag.withDescription("State directory path (forwards to T3CODE_STATE_DIR)."),
    Flag.optional,
  ),
  authToken: Flag.string("auth-token").pipe(
    Flag.withDescription("Auth token (forwards to T3CODE_AUTH_TOKEN)."),
    Flag.withAlias("token"),
    Flag.optional,
  ),
  noBrowser: Flag.string("no-browser").pipe(
    Flag.withDescription("Browser auto-open toggle. Accepts true/false/1/0/no."),
    Flag.optional,
  ),
  autoBootstrapProjectFromCwd: Flag.string("auto-bootstrap-project-from-cwd").pipe(
    Flag.withDescription("Auto-bootstrap toggle. Accepts true/false/1/0/no."),
    Flag.optional,
  ),
  logWebSocketEvents: Flag.string("log-websocket-events").pipe(
    Flag.withDescription("WebSocket event logging toggle. Accepts true/false/1/0/no."),
    Flag.withAlias("log-ws-events"),
    Flag.optional,
  ),
  host: Flag.string("host").pipe(
    Flag.withDescription("Server host/interface override (forwards to T3CODE_HOST)."),
    Flag.optional,
  ),
  port: Flag.string("port").pipe(
    Flag.withDescription("Server port override (forwards to T3CODE_PORT)."),
    Flag.optional,
  ),
  devUrl: Flag.string("dev-url").pipe(
    Flag.withDescription("Web dev URL override (forwards to VITE_DEV_SERVER_URL)."),
    Flag.optional,
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

export function runDevRunner(argv = process.argv) {
  return Command.runWith(devRunnerCli, { version: "0.0.0" })(argv.slice(2)).pipe(
    Effect.mapError((cause) =>
      cause instanceof DevRunnerError
        ? cause
        : new DevRunnerError({
            message: cause instanceof Error ? cause.message : "dev-runner argument parsing failed",
            cause,
          }),
    ),
  );
}

const runtimeLayer = Layer.mergeAll(
  Logger.layer([Logger.consolePretty()]),
  NodeServices.layer,
  NetService.layer,
);

const runtimeProgram = runDevRunner().pipe(Effect.scoped, Effect.provide(runtimeLayer));

if (import.meta.main) {
  NodeRuntime.runMain(runtimeProgram);
}
