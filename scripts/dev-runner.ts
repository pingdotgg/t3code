#!/usr/bin/env node

import * as NodeOS from "node:os";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NetService } from "@t3tools/shared/Net";
import { resolveGitWorktreePath, resolveWorktreeT3Home } from "@t3tools/shared/devHome";
import {
  Clock,
  Config,
  Data,
  Effect,
  FileSystem,
  Hash,
  Layer,
  Logger,
  Option,
  Path,
  Schedule,
  Schema,
} from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { ChildProcess } from "effect/unstable/process";

import { type DevShareError, shareDevServer, unshareDevServer } from "./lib/dev-share.ts";
import { loadRepoEnv } from "./lib/public-config.ts";

Object.assign(process.env, loadRepoEnv());

const BASE_SERVER_PORT = 13773;
const BASE_WEB_PORT = 5733;
const MAX_HASH_OFFSET = 3000;
const MAX_PORT = 65535;
const DEV_LOOPBACK_HOST = "127.0.0.1";
// HTTP(S) requests to these ports are blocked by the Fetch standard before a
// browser reaches the network. Keep the complete list here so explicit or
// future wider offsets cannot produce a URL that curl accepts but browsers
// reject. https://fetch.spec.whatwg.org/#port-blocking
const FETCH_BAD_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);
// Dev servers bind loopback, so loopback is the only interface whose
// availability decides whether we can use a port. Probing wildcards too made
// the runner walk away from a perfectly free port whenever something else held
// the same number on another interface — `tailscale serve` does exactly that,
// which silently moved the ports out from under a URL that had just been shared.
const DEV_PORT_PROBE_HOSTS = ["127.0.0.1", "::1"] as const;

/**
 * Bind hosts on which a backend still answers `http://localhost:<port>`, which
 * is where single-origin browser dev proxies to. Loopback and the wildcards
 * qualify; a specific interface (e.g. a LAN IP) does not — the OS binds only
 * that address and the proxy target goes dark.
 */
export function isProxiableBindHost(host: string): boolean {
  const normalized = host.trim();
  return (
    normalized === "" ||
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized === "0.0.0.0" ||
    normalized === "::" ||
    normalized === "[::]"
  );
}

export const DEFAULT_DEV_T3_HOME = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(NodeOS.homedir(), ".t3-dev"),
);

const MODE_ARGS = {
  dev: [
    "--parallel",
    "--filter",
    "@t3tools/contracts",
    "--filter",
    "@t3tools/web",
    "--filter",
    "t3",
  ],
  "dev:server": ["--filter", "t3"],
  "dev:web": ["--filter", "@t3tools/web"],
  "dev:desktop": ["--parallel", "--filter", "@t3tools/desktop", "--filter", "@t3tools/web"],
  // The stop mode never spawns the task runner (see the early branch in
  // runDevRunnerWithInput); it only exists here so the CLI accepts it.
  stop: [],
} as const satisfies Record<string, ReadonlyArray<string>>;

type DevMode = keyof typeof MODE_ARGS;
type PortAvailabilityCheck<R = never> = (port: number) => Effect.Effect<boolean, never, R>;

export function buildDevRunnerArgs(
  mode: DevMode,
  runnerArgs: ReadonlyArray<string>,
): Array<string> {
  if (mode === "stop") {
    throw new Error(
      "The stop mode never spawns the task runner; handle it before building runner args.",
    );
  }
  // Watch tasks cannot wait for dependencies to exit; runner flags must precede the task.
  return ["run", ...MODE_ARGS[mode], ...runnerArgs, "dev"];
}

const DEV_RUNNER_MODES = Object.keys(MODE_ARGS) as Array<DevMode>;

/** Runner modes that own a live server process and therefore a pidfile. */
const MANAGED_RUNNER_MODES: ReadonlyArray<string> = DEV_RUNNER_MODES.filter(
  (mode) => mode !== "stop",
);

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
  portOffset: optionalIntegerConfig("T3CODE_PORT_OFFSET"),
  devInstance: optionalStringConfig("T3CODE_DEV_INSTANCE"),
});

export function isBrowserAllowedPort(port: number): boolean {
  return !FETCH_BAD_PORTS.has(port);
}

export function resolveOffset(config: {
  readonly portOffset: number | undefined;
  readonly devInstance: string | undefined;
  readonly worktreePath?: string | undefined;
}): { readonly offset: number; readonly source: string } {
  if (config.portOffset !== undefined) {
    if (config.portOffset < 0) {
      throw new Error(`Invalid T3CODE_PORT_OFFSET: ${config.portOffset}`);
    }
    return {
      offset: config.portOffset,
      source: `T3CODE_PORT_OFFSET=${config.portOffset}`,
    };
  }

  const seed = config.devInstance?.trim();
  if (seed) {
    if (/^\d+$/.test(seed)) {
      return { offset: Number(seed), source: `numeric T3CODE_DEV_INSTANCE=${seed}` };
    }

    const offset = ((Hash.string(seed) >>> 0) % MAX_HASH_OFFSET) + 1;
    return { offset, source: `hashed T3CODE_DEV_INSTANCE=${seed}` };
  }

  // Worktrees get ports derived from their path so each one is stable across
  // restarts and distinct from its siblings. Without this every worktree starts
  // at offset 0 and scan-collides onto whatever happens to be free that minute,
  // so ports move under you between runs — which breaks any URL you already
  // shared. The main checkout keeps the documented 5733/13773.
  const worktreePath = config.worktreePath?.trim();
  if (worktreePath) {
    const offset = ((Hash.string(worktreePath) >>> 0) % MAX_HASH_OFFSET) + 1;
    return { offset, source: `worktree ${worktreePath}` };
  }

  return { offset: 0, source: "default ports" };
}

/**
 * State-home precedence for dev servers: explicit `--home-dir` wins, then the
 * worktree's own gitignored `.t3`, then ambient `T3CODE_HOME`. The flag must
 * NOT carry a `T3CODE_HOME` fallback (see its definition): the fallback would
 * arrive already merged into `flagHome` and make the worktree branch dead,
 * capturing worktree state into the shared home. Blank strings are not
 * selections — treating `--home-dir ""` as one would skip the worktree
 * default and land on the shared home.
 */
export function resolveDevT3Home(input: {
  readonly flagHome: string | undefined;
  readonly worktreeHome: string | undefined;
  readonly envHome: string | undefined;
}): string | undefined {
  return (
    (input.flagHome?.trim() || undefined) ??
    (input.worktreeHome?.trim() || undefined) ??
    (input.envHome?.trim() || undefined)
  );
}

function resolveBaseDir(baseDir: string | undefined): Effect.Effect<string, never, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const configured = baseDir?.trim();

    if (configured) {
      return path.resolve(configured);
    }

    return yield* DEFAULT_DEV_T3_HOME;
  });
}

interface CreateDevRunnerEnvInput {
  readonly mode: DevMode;
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly serverOffset: number;
  readonly webOffset: number;
  readonly t3Home: string | undefined;
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
  t3Home,
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
    const resolvedBaseDir = yield* resolveBaseDir(t3Home);
    const isDesktopMode = mode === "dev:desktop";
    const loopbackHost =
      !isDesktopMode && devUrl?.hostname === "localhost" ? "localhost" : DEV_LOOPBACK_HOST;

    const output: NodeJS.ProcessEnv = {
      ...baseEnv,
      HOST: baseEnv.HOST?.trim() || loopbackHost,
      PORT: String(webPort),
      VITE_DEV_SERVER_URL: devUrl?.toString() ?? `http://${DEV_LOOPBACK_HOST}:${webPort}`,
      T3CODE_HOME: resolvedBaseDir,
      T3CODE_PORT: String(serverPort),
      VITE_HTTP_URL: `http://${loopbackHost}:${serverPort}`,
      VITE_WS_URL: `ws://${loopbackHost}:${serverPort}`,
    };

    if (mode === "dev" || mode === "dev:web") {
      // Browser dev is single-origin: the web server proxies HTTP and WebSocket
      // requests to the backend, so clients must derive both URLs from the page.
      // The positive marker keeps Vite from restoring values loaded from .env.
      delete output.VITE_HTTP_URL;
      delete output.VITE_WS_URL;
      output.T3CODE_SINGLE_ORIGIN_DEV = "1";
    } else {
      delete output.T3CODE_SINGLE_ORIGIN_DEV;
    }

    if (isDesktopMode) {
      delete output.T3CODE_MODE;
      delete output.T3CODE_NO_BROWSER;
      delete output.T3CODE_HOST;
    }

    if (!isDesktopMode && host !== undefined) {
      output.T3CODE_HOST = host;
    }

    if (!isDesktopMode && noBrowser !== undefined) {
      output.T3CODE_NO_BROWSER = noBrowser ? "1" : "0";
    } else if (!isDesktopMode) {
      // Browser auto-open is opt-in: a dev runner that opens a browser tab on
      // every worktree boot surprises multi-worktree flows. Pass
      // --no-browser=false (or T3CODE_NO_BROWSER=0) to restore auto-open.
      output.T3CODE_NO_BROWSER = "1";
    }

    if (autoBootstrapProjectFromCwd !== undefined) {
      output.T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD = autoBootstrapProjectFromCwd ? "1" : "0";
    } else {
      delete output.T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD;
    }

    if (logWebSocketEvents !== undefined) {
      output.T3CODE_LOG_WS_EVENTS = logWebSocketEvents ? "1" : "0";
    } else {
      delete output.T3CODE_LOG_WS_EVENTS;
    }

    if (mode === "dev") {
      output.T3CODE_MODE = "web";
      delete output.T3CODE_DESKTOP_WS_URL;
    }

    if (mode === "dev:server" || mode === "dev:web") {
      output.T3CODE_MODE = "web";
      delete output.T3CODE_DESKTOP_WS_URL;
    }

    if (isDesktopMode) {
      output.HOST = DEV_LOOPBACK_HOST;
      delete output.T3CODE_DESKTOP_WS_URL;
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

      if (requireWebPort && !isBrowserAllowedPort(webPort)) {
        continue;
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
  readonly t3Home: Option.Option<string>;
  readonly noBrowser: boolean | undefined;
  readonly autoBootstrapProjectFromCwd: boolean | undefined;
  readonly logWebSocketEvents: boolean | undefined;
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly devUrl: URL | undefined;
  readonly dryRun: boolean;
  readonly share: boolean;
  readonly runnerArgs: ReadonlyArray<string>;
}

export const DEV_RUNNER_PID_FILE_PREFIX = "dev-runner-";
export const DEV_RUNNER_PID_FILE_SUFFIX = ".pid";

/** One pidfile per runner mode so concurrent runners stay independently stoppable. */
export function devRunnerPidFileName(mode: string): string {
  const slug =
    mode
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "unknown";
  return `${DEV_RUNNER_PID_FILE_PREFIX}${slug}${DEV_RUNNER_PID_FILE_SUFFIX}`;
}

export interface DevRunnerPidRecord {
  readonly pid: number;
  readonly serverPort: number;
  readonly webPort: number;
  readonly baseDir: string;
  readonly startedAt: string;
}

export function parseDevRunnerPidFile(text: string): DevRunnerPidRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const { pid, serverPort, webPort, baseDir, startedAt } = record;
  if (
    typeof pid !== "number" ||
    !Number.isInteger(pid) ||
    pid <= 0 ||
    typeof serverPort !== "number" ||
    !Number.isInteger(serverPort) ||
    serverPort < 1 ||
    serverPort > MAX_PORT ||
    typeof webPort !== "number" ||
    !Number.isInteger(webPort) ||
    webPort < 1 ||
    webPort > MAX_PORT ||
    typeof baseDir !== "string" ||
    baseDir.length === 0 ||
    typeof startedAt !== "string" ||
    Number.isNaN(Date.parse(startedAt))
  ) {
    return null;
  }
  return { pid, serverPort, webPort, baseDir, startedAt };
}

export interface DevRunnerProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
}

/**
 * Post-order (leaves first) kill sequence for a process tree, cycle-safe so a
 * malformed listing cannot loop forever. Pids missing from the listing (or an
 * unknown root) contribute nothing.
 */
export function computeProcessTreeKillOrder(
  entries: ReadonlyArray<DevRunnerProcessEntry>,
  rootPid: number,
): Array<number> {
  const children = new Map<number, Array<number>>();
  const known = new Set<number>();
  for (const entry of entries) {
    known.add(entry.pid);
    if (entry.pid === entry.ppid) continue;
    const siblings = children.get(entry.ppid) ?? [];
    siblings.push(entry.pid);
    children.set(entry.ppid, siblings);
  }
  if (!known.has(rootPid)) return [];
  const order: Array<number> = [];
  const visited = new Set<number>();
  const visit = (pid: number): void => {
    if (visited.has(pid)) return;
    visited.add(pid);
    for (const child of children.get(pid) ?? []) visit(child);
    order.push(pid);
  };
  visit(rootPid);
  return order;
}

export function writeDevRunnerPidFile(baseDir: string, mode: string, record: DevRunnerPidRecord) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const file = path.join(baseDir, devRunnerPidFileName(mode));
    yield* fs.makeDirectory(baseDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new DevRunnerError({
            message: `Failed to prepare dev pidfile directory ${baseDir}.`,
            cause,
          }),
      ),
    );
    yield* fs
      .writeFileString(file, `${JSON.stringify(record, null, 2)}\n`)
      .pipe(
        Effect.mapError(
          (cause) => new DevRunnerError({ message: `Failed to write dev pidfile ${file}.`, cause }),
        ),
      );
    return { path: file };
  });
}

export function readDevRunnerPidFile(baseDir: string, mode: string) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const file = path.join(baseDir, devRunnerPidFileName(mode));
    const text = yield* fs.readFileString(file).pipe(
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(cause),
      ),
      Effect.mapError(
        (cause) => new DevRunnerError({ message: `Failed to read dev pidfile ${file}.`, cause }),
      ),
    );
    if (text === null) return null;
    const record = parseDevRunnerPidFile(text);
    if (record === null) {
      return yield* new DevRunnerError({
        message: `Dev pidfile ${file} is corrupt (expected { pid, serverPort, webPort, baseDir, startedAt }). Remove it manually if no dev server owns ${baseDir}.`,
      });
    }
    return { path: file, record };
  });
}

export function removeDevRunnerPidFile(file: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(file).pipe(
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound" ? Effect.void : Effect.fail(cause),
      ),
      Effect.mapError(
        (cause) => new DevRunnerError({ message: `Failed to remove dev pidfile ${file}.`, cause }),
      ),
    );
  });
}

export interface DevRunnerProcessOperator {
  readonly isLive: (pid: number) => Effect.Effect<boolean, DevRunnerError>;
  readonly commandOf: (pid: number) => Effect.Effect<string | null, DevRunnerError>;
  readonly startedAtMsOf: (pid: number) => Effect.Effect<number | null, DevRunnerError>;
  readonly killTree: (pid: number) => Effect.Effect<ReadonlyArray<number>, DevRunnerError>;
}

export interface DevRunnerProcessIdentity {
  readonly command: string | null;
  readonly startedAtMs: number | null;
}

/** How far a process start time may lag the pidfile write and still corroborate it. */
export const DEV_RUNNER_IDENTITY_TIME_SKEW_MS = 60_000;

/**
 * Whether an observed process is the recorded runner. The command line must
 * belong to dev-runner, plus either a known home spelling (explicit
 * --home-dir) or a start time matching the record. The start-time half is
 * what identifies default worktree homes, env-provided homes, and relative
 * --home-dir flags, whose absolute spelling never appears in argv.
 */
export function devRunnerProcessMatchesRecord(
  identity: DevRunnerProcessIdentity,
  record: DevRunnerPidRecord,
  homes: ReadonlyArray<string>,
): boolean {
  if (identity.command === null || !identity.command.includes("dev-runner")) return false;
  if (homes.some((home) => home.length > 0 && identity.command?.includes(home))) return true;
  if (identity.startedAtMs === null) return false;
  const recordedStartedAtMs = Date.parse(record.startedAt);
  if (Number.isNaN(recordedStartedAtMs)) return false;
  return Math.abs(identity.startedAtMs - recordedStartedAtMs) <= DEV_RUNNER_IDENTITY_TIME_SKEW_MS;
}

export type PidfileOwnerStatus =
  | { readonly status: "absent" }
  | { readonly status: "owned-live" }
  | { readonly status: "stale" }
  | { readonly status: "foreign-live" };

/**
 * Classifies a pidfile record against the observed process state. Pure so
 * both the startup conflict check and the stop flow share one rule: a null
 * identity means the pid is already dead (the caller checks liveness first).
 */
export function classifyPidfileOwner(
  record: DevRunnerPidRecord | null,
  identity: DevRunnerProcessIdentity | null,
  homes: ReadonlyArray<string>,
): PidfileOwnerStatus {
  if (record === null) return { status: "absent" };
  if (identity === null) return { status: "stale" };
  return devRunnerProcessMatchesRecord(identity, record, homes)
    ? { status: "owned-live" }
    : { status: "foreign-live" };
}

/** Parses `ps -o etime=` output ([[dd-]hh:]mm:ss) into milliseconds. */
export function parsePsElapsedToMs(value: string): number | null {
  const match = value.trim().match(/^(?:(\d+)-)?(\d+):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const days = match[1] === undefined ? 0 : Number(match[1]);
  const hasSeconds = match[4] !== undefined;
  const hours = hasSeconds ? Number(match[2]) : 0;
  const minutes = Number(hasSeconds ? match[3] : match[2]);
  const seconds = hasSeconds ? Number(match[4]) : Number(match[3]);
  if (
    !Number.isInteger(days) ||
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    minutes > 59 ||
    !Number.isInteger(seconds) ||
    seconds > 59
  ) {
    return null;
  }
  return ((days * 24 + hours) * 3600 + minutes * 60 + seconds) * 1000;
}

/** Parses a CIM datetime (Win32_Process CreationDate) into epoch milliseconds. */
export function parseCimCreationDateToMs(value: string): number | null {
  // CIM offsets are whole minutes, e.g. "-420" for UTC-7.
  const match = value
    .trim()
    .match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?([+-])(\d{3})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, sign, offsetMinutes] = match;
  const parts = [year, month, day, hour, minute, second, offsetMinutes].map(Number);
  if (parts.some((part) => !Number.isInteger(part))) return null;
  const [y, mo, d, h, mi, s, offMin] = parts as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
  const offsetMs = (sign === "+" ? 1 : -1) * offMin * 60_000;
  return Date.UTC(y, mo - 1, d, h, mi, s) - offsetMs;
}

export type DevRunnerStopResult =
  | { readonly stopped: true; readonly killed: ReadonlyArray<number> }
  | {
      readonly stopped: false;
      readonly reason: "not-running";
      readonly killed: ReadonlyArray<number>;
    };

export function stopDevEnvironment(input: {
  readonly baseDir: string;
  readonly mode: string;
  readonly readPidFile: () => Effect.Effect<
    { readonly path: string; readonly record: DevRunnerPidRecord } | null,
    DevRunnerError,
    FileSystem.FileSystem | Path.Path
  >;
  readonly removePidFile: (
    path: string,
  ) => Effect.Effect<void, DevRunnerError, FileSystem.FileSystem>;
  readonly operator: DevRunnerProcessOperator;
}) {
  return Effect.gen(function* () {
    const pidFile = yield* input.readPidFile();
    if (pidFile === null) {
      return yield* new DevRunnerError({
        message: `No ${input.mode} dev server is recorded for ${input.baseDir} (missing ${devRunnerPidFileName(input.mode)}). Nothing to stop.`,
      });
    }
    const identity = yield* observeRunnerIdentity(input.operator, pidFile.record.pid);
    const status = classifyPidfileOwner(pidFile.record, identity, [
      pidFile.record.baseDir,
      input.baseDir,
    ]);
    if (status.status === "stale") {
      yield* input.removePidFile(pidFile.path);
      return { stopped: false, reason: "not-running", killed: [] } as const;
    }
    if (status.status !== "owned-live") {
      return yield* new DevRunnerError({
        message: `Refusing to stop pid ${String(pidFile.record.pid)}: it does not look like the '${input.mode}' runner for ${pidFile.record.baseDir}. Remove ${pidFile.path} manually if you are sure nothing owns it.`,
      });
    }
    const killed = yield* input.operator.killTree(pidFile.record.pid);
    yield* input.removePidFile(pidFile.path);
    return { stopped: true, killed: [...killed] } as const;
  });
}

/**
 * Removes a mode pidfile only while it still belongs to the exiting process.
 * A concurrent runner legitimately owns anything else, so unconditional
 * exit cleanup could delete another runner's live record.
 */
export function removeOwnDevRunnerPidFile(input: {
  readonly readPidFile: () => Effect.Effect<
    { readonly path: string; readonly record: DevRunnerPidRecord } | null,
    DevRunnerError,
    FileSystem.FileSystem | Path.Path
  >;
  readonly removePidFile: (
    path: string,
  ) => Effect.Effect<void, DevRunnerError, FileSystem.FileSystem>;
}) {
  return Effect.gen(function* () {
    const pidFile = yield* input.readPidFile();
    if (pidFile === null || pidFile.record.pid !== process.pid) return false;
    yield* input.removePidFile(pidFile.path);
    return true;
  });
}

export interface DevRunnerStopAllResult {
  readonly stopped: ReadonlyArray<{
    readonly mode: string;
    readonly killed: ReadonlyArray<number>;
  }>;
  readonly cleared: ReadonlyArray<string>;
}

/**
 * Stops every recorded runner for one home directory. Validates all records
 * before touching anything: a single foreign record aborts the whole stop so
 * a corrupt pidfile can never strand the remaining live servers.
 */
export function stopAllDevEnvironments(input: {
  readonly baseDir: string;
  readonly modes?: ReadonlyArray<string>;
  readonly readPidFile: (
    mode: string,
  ) => Effect.Effect<
    { readonly path: string; readonly record: DevRunnerPidRecord } | null,
    DevRunnerError,
    FileSystem.FileSystem | Path.Path
  >;
  readonly removePidFile: (
    path: string,
  ) => Effect.Effect<void, DevRunnerError, FileSystem.FileSystem>;
  readonly operator: DevRunnerProcessOperator;
}) {
  return Effect.gen(function* () {
    const modes = input.modes ?? MANAGED_RUNNER_MODES;
    const plans: Array<{
      mode: string;
      pidFile: { readonly path: string; readonly record: DevRunnerPidRecord };
      status: PidfileOwnerStatus;
    }> = [];
    for (const mode of modes) {
      const pidFile = yield* input.readPidFile(mode);
      if (pidFile === null) continue;
      const identity = yield* observeRunnerIdentity(input.operator, pidFile.record.pid);
      const status = classifyPidfileOwner(pidFile.record, identity, [
        pidFile.record.baseDir,
        input.baseDir,
      ]);
      if (status.status === "foreign-live") {
        return yield* new DevRunnerError({
          message: `Refusing to stop: ${devRunnerPidFileName(mode)} points at live pid ${String(pidFile.record.pid)}, which does not look like a runner for ${pidFile.record.baseDir}. Remove ${pidFile.path} manually if you are sure nothing owns it. Nothing was stopped.`,
        });
      }
      plans.push({ mode, pidFile, status });
    }
    if (plans.length === 0) {
      return yield* new DevRunnerError({
        message: `No dev server is recorded for ${input.baseDir}. Nothing to stop.`,
      });
    }
    const stopped: Array<{ mode: string; killed: ReadonlyArray<number> }> = [];
    const cleared: Array<string> = [];
    for (const plan of plans) {
      if (plan.status.status === "stale") {
        yield* input.removePidFile(plan.pidFile.path);
        cleared.push(plan.mode);
        continue;
      }
      const killed = yield* input.operator.killTree(plan.pidFile.record.pid);
      yield* input.removePidFile(plan.pidFile.path);
      stopped.push({ mode: plan.mode, killed: [...killed] });
    }
    return { stopped, cleared } as const;
  });
}

const observeRunnerIdentity = (operator: DevRunnerProcessOperator, pid: number) =>
  Effect.gen(function* () {
    if (!(yield* operator.isLive(pid))) return null;
    const [command, startedAtMs] = yield* Effect.all(
      [
        operator.commandOf(pid).pipe(Effect.catch(() => Effect.succeed(null))),
        operator.startedAtMsOf(pid).pipe(Effect.catch(() => Effect.succeed(null))),
      ],
      { concurrency: 2 },
    );
    return { command, startedAtMs };
  });

const execFileAsync = promisify(execFileCallback);
const DEV_STOP_GRACE_MS = 3000;
const DEV_STOP_POLL_MS = 250;

const parsePsProcessList = (stdout: string): Array<DevRunnerProcessEntry> => {
  const entries: Array<DevRunnerProcessEntry> = [];
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    entries.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? "" });
  }
  return entries;
};

const waitUntilDead = (isLive: (pid: number) => Effect.Effect<boolean, DevRunnerError>) =>
  Effect.fn("devRunner.waitUntilDead")(function* (pids: ReadonlyArray<number>) {
    const deadline = Date.now() + DEV_STOP_GRACE_MS;
    for (;;) {
      const alive: Array<number> = [];
      for (const pid of pids) {
        if (yield* isLive(pid)) alive.push(pid);
      }
      if (alive.length === 0 || Date.now() >= deadline) return alive;
      yield* Effect.sleep(`${DEV_STOP_POLL_MS} millis`);
    }
  });

const killUnixProcessTree = (
  order: ReadonlyArray<number>,
  isLive: (pid: number) => Effect.Effect<boolean, DevRunnerError>,
  signal: NodeJS.Signals,
) =>
  Effect.gen(function* () {
    for (const pid of order) {
      try {
        process.kill(pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ESRCH") throw error;
      }
    }
    return yield* waitUntilDead(isLive)(order);
  });

/**
 * Local-machine process operator. Identity is always verified against the
 * recorded command line before killing, so a recycled pid can never take
 * down an unrelated process. The Windows path uses taskkill and is noted
 * untested (no Windows runner here); the Unix path is covered by tests plus a
 * live stop below.
 */
export const localProcessOperator = (): DevRunnerProcessOperator => {
  const isLive = (pid: number) =>
    Effect.sync(() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
      }
    });
  const commandOf = (pid: number) =>
    Effect.gen(function* () {
      if (process.platform === "win32") {
        const { stdout } = yield* Effect.tryPromise({
          try: () =>
            execFileAsync("powershell", [
              "-NoProfile",
              "-Command",
              `(Get-CimInstance Win32_Process -Filter 'ProcessId=${String(pid)}').CommandLine`,
            ]),
          catch: (cause) =>
            new DevRunnerError({ message: `Failed to inspect pid ${String(pid)}.`, cause }),
        }).pipe(Effect.catch(() => Effect.succeed({ stdout: "" })));
        const command = stdout.trim();
        return command.length > 0 ? command : null;
      }
      const { stdout } = yield* Effect.tryPromise({
        try: () => execFileAsync("ps", ["-ww", "-o", "command=", "-p", String(pid)]),
        catch: (cause) =>
          new DevRunnerError({ message: `Failed to inspect pid ${String(pid)}.`, cause }),
      }).pipe(Effect.catch(() => Effect.succeed({ stdout: "" })));
      const command = stdout.trim();
      return command.length > 0 ? command : null;
    });
  const startedAtMsOf = (pid: number) =>
    Effect.gen(function* () {
      if (process.platform === "win32") {
        const { stdout } = yield* Effect.tryPromise({
          try: () =>
            execFileAsync("powershell", [
              "-NoProfile",
              "-Command",
              `(Get-CimInstance Win32_Process -Filter 'ProcessId=${String(pid)}').CreationDate`,
            ]),
          catch: (cause) =>
            new DevRunnerError({ message: `Failed to inspect pid ${String(pid)}.`, cause }),
        }).pipe(Effect.catch(() => Effect.succeed({ stdout: "" })));
        return parseCimCreationDateToMs(stdout);
      }
      const { stdout } = yield* Effect.tryPromise({
        try: () => execFileAsync("ps", ["-ww", "-o", "etime=", "-p", String(pid)]),
        catch: (cause) =>
          new DevRunnerError({ message: `Failed to inspect pid ${String(pid)}.`, cause }),
      }).pipe(Effect.catch(() => Effect.succeed({ stdout: "" })));
      const elapsedMs = parsePsElapsedToMs(stdout);
      return elapsedMs === null ? null : Date.now() - elapsedMs;
    });
  const killTree = (pid: number) =>
    Effect.gen(function* () {
      if (process.platform === "win32") {
        yield* Effect.tryPromise({
          try: () => execFileAsync("taskkill", ["/PID", String(pid), "/T"]),
          catch: (cause) =>
            new DevRunnerError({ message: `Failed to stop pid ${String(pid)}.`, cause }),
        });
        const survivors = yield* waitUntilDead(isLive)([pid]);
        if (survivors.length > 0) {
          yield* Effect.tryPromise({
            try: () => execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"]),
            catch: (cause) =>
              new DevRunnerError({ message: `Failed to force-stop pid ${String(pid)}.`, cause }),
          });
          const forced = yield* waitUntilDead(isLive)([pid]);
          if (forced.length > 0) {
            return yield* new DevRunnerError({
              message: `Pid ${String(pid)} is still alive after taskkill. Stop it manually.`,
            });
          }
        }
        return [pid] as const;
      }
      const { stdout } = yield* Effect.tryPromise({
        try: () => execFileAsync("ps", ["-ww", "-eo", "pid=,ppid=,command="]),
        catch: (cause) =>
          new DevRunnerError({ message: "Failed to list processes for dev stop.", cause }),
      });
      const order = computeProcessTreeKillOrder(parsePsProcessList(stdout), pid);
      const targets = order.length > 0 ? order : [pid];
      const survivors = yield* killUnixProcessTree(targets, isLive, "SIGTERM");
      if (survivors.length === 0) return [...targets] as const;
      const forced = yield* killUnixProcessTree(survivors, isLive, "SIGKILL");
      if (forced.length > 0) {
        return yield* new DevRunnerError({
          message: `Pids ${forced.join(", ")} are still alive after SIGKILL. Stop them manually.`,
        });
      }
      return [...targets] as const;
    });
  return { isLive, commandOf, startedAtMsOf, killTree };
};

interface DevRunnerCliInput {
  readonly mode: DevMode;
  readonly t3Home: Option.Option<string>;
  readonly noBrowser: boolean | undefined;
  readonly autoBootstrapProjectFromCwd: boolean | undefined;
  readonly logWebSocketEvents: boolean | undefined;
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly devUrl: URL | undefined;
  readonly dryRun: boolean;
  readonly share: boolean;
  readonly runnerArgs: ReadonlyArray<string>;
}

export interface DevWebWarmupInput {
  readonly url: string;
  /** Warmed once after `url` answers, to pre-transform the app entry. */
  readonly entryUrl?: string;
  readonly fetchImpl?: (
    url: string,
    init?: { signal: AbortSignal },
  ) => Promise<{ arrayBuffer(): Promise<unknown> }>;
  readonly pollIntervalMs?: number;
  readonly attemptTimeoutMs?: number;
  readonly timeoutMs?: number;
}

/**
 * Poll a Vite dev origin until it answers, so the cold dependency
 * re-optimization happens on this background fiber instead of on the agent's
 * first real navigation. Any HTTP response counts — even an error status
 * proves the server is up. Never fails: gives up quietly after the timeout.
 * Every attempt is abortable and bounded, so fiber interruption cancels the
 * in-flight request.
 */
export function warmupDevWebServer(input: DevWebWarmupInput) {
  return Effect.gen(function* () {
    const fetchImpl =
      input.fetchImpl ?? ((url: string, init?: { signal: AbortSignal }) => fetch(url, init));
    const pollIntervalMs = input.pollIntervalMs ?? 250;
    const attemptTimeoutMs = input.attemptTimeoutMs ?? 10_000;
    const timeoutMs = input.timeoutMs ?? 180_000;
    const startedAt = yield* Clock.currentTimeMillis;
    const fetchOnce = (url: string) =>
      Effect.tryPromise({
        try: (signal) =>
          Promise.resolve()
            .then(() => fetchImpl(url, { signal }))
            .then(
              // Any settlement (even a body-read failure) proves the server
              // is up; draining frees the connection.
              (response) =>
                response
                  .arrayBuffer()
                  .then(() => true)
                  .catch(() => true),
              () => false,
            ),
        catch: (cause) =>
          new DevRunnerError({ message: `dev web warmup fetch failed: ${url}`, cause }),
      }).pipe(
        Effect.flatMap((up) =>
          up
            ? Effect.succeed(true as const)
            : Effect.fail(new DevRunnerError({ message: `dev web not up yet: ${url}` })),
        ),
        Effect.timeout(attemptTimeoutMs),
      );
    const finished = yield* fetchOnce(input.url).pipe(
      Effect.retry(Schedule.spaced(pollIntervalMs)),
      Effect.tap(() =>
        input.entryUrl === undefined ? Effect.void : fetchOnce(input.entryUrl).pipe(Effect.ignore),
      ),
      Effect.timeoutOption(timeoutMs),
    );
    const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
    if (Option.isSome(finished)) {
      yield* Effect.logInfo(`[dev-runner] warmup ${input.url} answered in ${String(elapsed)}ms.`);
    } else {
      yield* Effect.logWarning(
        `[dev-runner] warmup ${input.url} never answered within ${String(timeoutMs)}ms; continuing without it.`,
      );
    }
  });
}

/** Runner modes that serve the Vite web origin on `env.PORT`. */
const WEB_SERVING_MODES: ReadonlySet<DevMode> = new Set(["dev", "dev:web", "dev:desktop"]);

export function runDevRunnerWithInput(input: DevRunnerCliInput) {
  return Effect.gen(function* () {
    if (input.mode === "stop") {
      const flagHome = Option.getOrUndefined(input.t3Home)?.trim() || undefined;
      if (flagHome === undefined) {
        return yield* new DevRunnerError({
          message:
            "Stop requires --home-dir <dir> so an unintended server is never touched. Pass the same directory the server was started with.",
        });
      }
      const path = yield* Path.Path;
      const baseDir = path.resolve(flagHome);
      const operator = localProcessOperator();
      const result = yield* stopAllDevEnvironments({
        baseDir,
        readPidFile: (mode) => readDevRunnerPidFile(baseDir, mode),
        removePidFile: removeDevRunnerPidFile,
        operator,
      });
      for (const entry of result.stopped) {
        yield* Effect.logInfo(
          `[dev-runner] stopped '${entry.mode}' runner for ${baseDir} (killed pids ${entry.killed.join(", ")}).`,
        );
      }
      for (const mode of result.cleared) {
        yield* Effect.logInfo(`[dev-runner] cleared stale ${mode} pidfile for ${baseDir}.`);
      }
      return;
    }

    const { portOffset, devInstance } = yield* OffsetConfig.pipe(
      Effect.mapError(
        (cause) =>
          new DevRunnerError({
            message: "Failed to read T3CODE_PORT_OFFSET/T3CODE_DEV_INSTANCE configuration.",
            cause,
          }),
      ),
    );

    // Single-origin browser dev proxies the backend at localhost. A wildcard
    // bind still answers there; a specific non-loopback interface does not,
    // which breaks every proxied request in a way that reads as "server is
    // broken" rather than "flag combination is unsupported". Reject it up
    // front instead. (dev:server and dev:desktop don't proxy — untouched.)
    if (
      (input.mode === "dev" || input.mode === "dev:web") &&
      input.host !== undefined &&
      !isProxiableBindHost(input.host)
    ) {
      return yield* new DevRunnerError({
        message: `--host ${input.host} cannot be combined with ${input.mode}: single-origin browser dev proxies the backend at localhost, and a backend bound only to ${input.host} leaves localhost unanswered, so every proxied request fails. Use a wildcard (0.0.0.0 or ::) to serve that interface and loopback together, or --share for remote access.`,
      });
    }

    const cwd = process.cwd();
    const worktreePath = yield* resolveGitWorktreePath(cwd);

    const { offset, source } = yield* Effect.try({
      try: () => resolveOffset({ portOffset, devInstance, worktreePath }),
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

    // A dev server started inside a worktree defaults to that worktree's own
    // (gitignored) `.t3` — an ambient T3CODE_HOME must not capture worktree
    // state into the shared home. `--home-dir` still wins; otherwise fall back
    // to the isolated fork default below via createDevRunnerEnv.
    const worktreeHome = yield* resolveWorktreeT3Home(cwd);
    const resolvedT3Home = resolveDevT3Home({
      flagHome: Option.getOrUndefined(input.t3Home),
      worktreeHome,
      envHome: process.env.T3CODE_HOME,
    });

    const env = yield* createDevRunnerEnv({
      mode: input.mode,
      baseEnv: process.env,
      serverOffset,
      webOffset,
      t3Home: resolvedT3Home,
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
      `[dev-runner] mode=${input.mode} source=${source}${selectionSuffix} serverPort=${String(env.T3CODE_PORT)} webPort=${String(env.PORT)} baseDir=${String(env.T3CODE_HOME)}`,
    );

    // --dry-run only resolves and prints. Sharing would replace, then tear
    // down, whatever mapping the port already had — a surprising side effect
    // from a command documented as inert.
    if (input.dryRun) {
      return;
    }

    // Record this server on disk so `dev:stop` (and agents) can find and reap
    // it later instead of accumulating orphaned isolated environments. One
    // pidfile per runner mode: `dev:server` + `dev:web` against the same home
    // is a supported split, while a second runner for the same mode is
    // rejected below before it can contend for the same SQLite database.
    const pidBaseDir =
      resolvedT3Home === undefined
        ? yield* DEFAULT_DEV_T3_HOME
        : (yield* Path.Path).resolve(resolvedT3Home);
    const stopHint = `pnpm dev:stop --home-dir ${pidBaseDir}`;
    const pidOperator = localProcessOperator();
    const readOwnPidFile = () => readDevRunnerPidFile(pidBaseDir, input.mode);
    const existingPid = yield* readOwnPidFile().pipe(Effect.catch(() => Effect.succeed(null)));
    if (existingPid !== null) {
      const identity = yield* observeRunnerIdentity(pidOperator, existingPid.record.pid);
      const owner = classifyPidfileOwner(existingPid.record, identity, [
        existingPid.record.baseDir,
        pidBaseDir,
      ]);
      if (owner.status === "owned-live") {
        const running = existingPid.record;
        return yield* new DevRunnerError({
          message: `A '${input.mode}' runner (pid ${String(running.pid)}, serverPort ${String(running.serverPort)}, webPort ${String(running.webPort)}, started ${running.startedAt}) is already running for ${pidBaseDir}. Stop it first: ${stopHint}.`,
        });
      }
      if (owner.status === "foreign-live") {
        yield* Effect.logWarning(
          `[dev-runner] pidfile ${existingPid.path} points at live pid ${String(existingPid.record.pid)}, which is not this environment's runner; replacing the stale record. The other process is left alone.`,
        );
      }
    }
    const pidRecord: DevRunnerPidRecord = {
      pid: process.pid,
      serverPort: Number(env.T3CODE_PORT),
      webPort: Number(env.PORT),
      baseDir: pidBaseDir,
      startedAt: new Date().toISOString(),
    };
    yield* Effect.acquireRelease(writeDevRunnerPidFile(pidBaseDir, input.mode, pidRecord), () =>
      removeOwnDevRunnerPidFile({
        readPidFile: readOwnPidFile,
        removePidFile: removeDevRunnerPidFile,
      }).pipe(Effect.ignore),
    );
    yield* Effect.logInfo(
      `[dev-runner] pid ${String(process.pid)}; stop this server later with: ${stopHint}`,
    );

    const sharedWebPort = BASE_WEB_PORT + webOffset;
    if (input.share) {
      if (input.mode === "dev:server") {
        yield* Effect.logInfo("[dev-runner] --share has no effect for dev:server (no web server).");
      } else if (input.mode === "dev:desktop") {
        yield* Effect.logWarning(
          "[dev-runner] --share is not supported for dev:desktop (the renderer is pinned to loopback). Use `dev`, which runs the whole browser stack.",
        );
      } else {
        // acquireRelease, not share-then-addFinalizer: the mapping outlives
        // this process (and reboots), so the cleanup has to be registered
        // atomically with creating it. An interrupt landing in between would
        // otherwise leave a mapping pointing at a port nothing listens on.
        //
        // A tailnet that isn't up shouldn't stop the dev server from starting —
        // warn, and carry on serving locally.
        const shared = yield* Effect.acquireRelease(
          shareDevServer({ webPort: sharedWebPort }),
          () =>
            // Serve config outlives this process, so a cleanup that did not
            // take leaves a tailnet URL pointing at a port nothing serves.
            unshareDevServer(sharedWebPort).pipe(
              Effect.flatMap((result) =>
                result.cleared
                  ? Effect.void
                  : Effect.logWarning(
                      `[dev-runner] could not remove the tailnet mapping for port ${String(sharedWebPort)}${
                        result.explanation ? `: ${result.explanation}` : ""
                      }. Remove it with \`tailscale serve --https=${String(sharedWebPort)} off\`.`,
                    ),
              ),
            ),
        ).pipe(
          Effect.tapError((error: DevShareError) =>
            Effect.logWarning(
              `[dev-runner] could not share on the tailnet: ${error.message}${
                "hint" in error && typeof error.hint === "string" ? ` — ${error.hint}` : ""
              }`,
            ),
          ),
          Effect.option,
          Effect.map(Option.getOrUndefined),
        );

        if (shared) {
          // The server builds its pairing URL from this, so the URL printed at
          // startup is already the shareable one. An explicit --dev-url still wins.
          if (input.devUrl === undefined) {
            env.VITE_DEV_SERVER_URL = shared.url;
          }
          yield* Effect.logInfo(`[dev-runner] shared on tailnet: ${shared.url}`);
        }
      }
    }

    // Warm the Vite origin on a background fiber while the task runner boots:
    // the first request pays the cold dependency re-optimization, so the
    // agent's first real navigation does not. `env.PORT` is the Vite port in
    // every allowlisted mode (`dev:server` runs no web server, so it is out).
    // The entry fetch mirrors apps/web/index.html to pre-transform the app
    // entry through the same path a browser would use.
    if (WEB_SERVING_MODES.has(input.mode)) {
      yield* warmupDevWebServer({
        url: `http://${DEV_LOOPBACK_HOST}:${String(env.PORT)}/`,
        entryUrl: `http://${DEV_LOOPBACK_HOST}:${String(env.PORT)}/src/main.tsx`,
      }).pipe(Effect.forkScoped);
    }

    const child = yield* ChildProcess.make("vp", buildDevRunnerArgs(input.mode, input.runnerArgs), {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env,
      extendEnv: false,
      // Windows needs shell mode to resolve .cmd shims on PATH.
      shell: process.platform === "win32",
      // Keep the task runner in the same process group so terminal signals (Ctrl+C)
      // reach it directly. Effect defaults to detached: true on non-Windows,
      // which would put the runner in a new group and require manual forwarding.
      detached: false,
      forceKillAfter: "1500 millis",
    });

    const exitCode = yield* child.exitCode;
    if (exitCode !== 0) {
      return yield* new DevRunnerError({
        message: `vp exited with code ${exitCode}`,
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
  t3Home: Flag.string("home-dir").pipe(
    Flag.withDescription(
      "Base directory for all T3 Code data (equivalent to T3CODE_HOME). Inside a git worktree this defaults to that worktree's own .t3 so dev state stays off the shared home. Deliberately no T3CODE_HOME fallback here: the ambient value is applied after the worktree default (see resolveDevT3Home), otherwise it would silently capture worktree state into the shared home.",
    ),
    Flag.optional,
  ),
  noBrowser: Flag.boolean("no-browser").pipe(
    Flag.withDescription("Browser auto-open toggle (equivalent to T3CODE_NO_BROWSER)."),
    Flag.withFallbackConfig(optionalBooleanConfig("T3CODE_NO_BROWSER")),
  ),
  autoBootstrapProjectFromCwd: Flag.boolean("auto-bootstrap-project-from-cwd").pipe(
    Flag.withDescription(
      "Auto-bootstrap toggle (equivalent to T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD).",
    ),
    Flag.withFallbackConfig(optionalBooleanConfig("T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD")),
  ),
  logWebSocketEvents: Flag.boolean("log-websocket-events").pipe(
    Flag.withDescription("WebSocket event logging toggle (equivalent to T3CODE_LOG_WS_EVENTS)."),
    Flag.withAlias("log-ws-events"),
    Flag.withFallbackConfig(optionalBooleanConfig("T3CODE_LOG_WS_EVENTS")),
  ),
  host: Flag.string("host").pipe(
    Flag.withDescription("Server host/interface override (forwards to T3CODE_HOST)."),
    Flag.withFallbackConfig(optionalStringConfig("T3CODE_HOST")),
  ),
  port: Flag.integer("port").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
    Flag.withDescription("Server port override (forwards to T3CODE_PORT)."),
    Flag.withFallbackConfig(optionalPortConfig("T3CODE_PORT")),
  ),
  devUrl: Flag.string("dev-url").pipe(
    Flag.withSchema(Schema.URLFromString),
    Flag.withDescription("Web dev URL override (forwards to VITE_DEV_SERVER_URL)."),
    Flag.withFallbackConfig(optionalUrlConfig("VITE_DEV_SERVER_URL")),
  ),
  dryRun: Flag.boolean("dry-run").pipe(
    Flag.withDescription("Resolve mode/ports/env and print, but do not spawn the task runner."),
    Flag.withDefault(false),
  ),
  share: Flag.boolean("share").pipe(
    Flag.withDescription(
      "Publish the web dev server on this machine's tailnet over HTTPS (via `tailscale serve`) and print the pairing URL for it. Removed again on exit.",
    ),
    Flag.withDefault(false),
  ),
  runnerArgs: Argument.string("runner-arg").pipe(
    Argument.withDescription(
      "Additional arguments forwarded to selected dev tasks (pass after `--`).",
    ),
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
