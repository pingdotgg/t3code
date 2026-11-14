import {
  CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS,
  PREVIEW_URL_MAX_LENGTH,
  PreviewStopLocalServerError,
  ThreadId,
  type DiscoveredLocalServer,
  type PreviewStopLocalServerInput,
} from "@t3tools/contracts";
import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isLoopbackHost, LSOF_LOCAL_HOST_TOKENS } from "@t3tools/shared/preview";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { FetchHttpClient, HttpClient } from "effect/http";

import * as WindowsTcpListeners from "../process/windowsTcpListeners.ts";
import * as ProcessRunner from "../processRunner.ts";

export class PortDiscovery extends Context.Service<
  PortDiscovery,
  {
    readonly scan: (
      configuredUrls?: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<DiscoveredLocalServer>>;
    readonly subscribe: (
      input: {
        readonly configuredUrls: ReadonlyArray<string>;
        readonly initialSnapshot: ReadonlyArray<DiscoveredLocalServer>;
      },
      listener: (servers: ReadonlyArray<DiscoveredLocalServer>) => Effect.Effect<void>,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly retain: Effect.Effect<void, never, Scope.Scope>;
    readonly registerTerminalProcesses: (input: {
      readonly threadId: string;
      readonly terminalId: string;
      readonly processIds: ReadonlyArray<number>;
    }) => Effect.Effect<void>;
    readonly unregisterTerminal: (input: {
      readonly threadId: string;
      readonly terminalId: string;
    }) => Effect.Effect<void>;
    /**
     * Counts a running agent until the returned function is called. While one runs, any
     * listener may be a server it started. Synchronous because provider spawn callbacks run
     * outside Effect.
     */
    readonly trackAgent: () => () => void;
    /** Stops a listed server's process group, never this server, an agent CLI, or a shell. */
    readonly stopServer: (
      input: PreviewStopLocalServerInput,
    ) => Effect.Effect<void, PreviewStopLocalServerError>;
  }
>()("t3/preview/PortScanner/PortDiscovery") {}

/**
 * Agents launch with this set to their thread, and every job they start inherits it, so a
 * server stays attributed after its launching shell exits or the agent settles.
 */
export const AGENT_THREAD_ENV = "T3CODE_THREAD_ID";

/** `0` turns off listener discovery; configured preview URLs are still probed. */
export const PORT_DISCOVERY_ENV = "T3CODE_PORT_DISCOVERY";

export const POLL_INTERVAL = Duration.seconds(3);
export const LSOF_TIMEOUT_MS = 5_000;
export const PROC_FD_WALK_LIMIT = 50_000;
export const SOCKET_OWNER_ATTEMPTS = 3;
export const WINDOWS_LISTENER_TIMEOUT_MS = 5_000;
export const WEB_PROBE_TIMEOUT = Duration.seconds(1);
export const WEB_PROBE_CACHE_TTL_MS = Duration.toMillis(Duration.seconds(15));
/** Bounds how long a cached Windows image name can outlive its process if Windows reuses the PID. */
export const WINDOWS_PROCESS_NAME_TTL_MS = Duration.toMillis(Duration.seconds(60));
export const WINDOWS_PROCESS_NAME_CONCURRENCY = 4;
export const WEB_PROBE_CONCURRENCY = 16;
export const NAVIGATION_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
export const PS_TIMEOUT_MS = 5_000;
export const PS_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const STOP_GRACE_MS = 3_000;
export const STOP_POLL_INTERVAL = Duration.millis(250);

export type Listener = (servers: ReadonlyArray<DiscoveredLocalServer>) => Effect.Effect<void>;

export interface ListenerSubscription {
  readonly configuredUrls: ReadonlyArray<string>;
  readonly lastSnapshot: ReadonlyArray<DiscoveredLocalServer>;
}

export interface ScannerState {
  readonly listeners: ReadonlyMap<Listener, ListenerSubscription>;
  readonly terminalProcesses: ReadonlyMap<
    string,
    {
      readonly owner: TerminalProcessOwner;
      readonly processIds: ReadonlySet<number>;
    }
  >;
  readonly retainCount: number;
}

interface TerminalProcessOwner {
  readonly threadId: ThreadId;
  readonly terminalId: string;
}

export type ServerOwner = Pick<DiscoveredLocalServer, "terminal" | "agent">;

export const UNOWNED: ServerOwner = { terminal: null, agent: null };

export const isOwned = (server: DiscoveredLocalServer): boolean =>
  server.terminal !== null || (server.agent ?? null) !== null;

interface ProcessTableRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
}

export interface WebProbeCacheEntry {
  readonly pid: number | null;
  readonly isWeb: boolean;
  readonly expiresAtMillis: number;
}

export interface WebProbeGroup {
  readonly server: DiscoveredLocalServer;
  readonly url: string;
  readonly configuredKey: string;
}

export interface WebProbeSnapshot {
  readonly discovered: ReadonlyArray<DiscoveredLocalServer>;
  readonly configured: ReadonlyMap<string, DiscoveredLocalServer>;
}

export const terminalOwnerKey = (owner: {
  readonly threadId: string;
  readonly terminalId: string;
}): string => `${owner.threadId}\u0000${owner.terminalId}`;

const parseConfiguredUrl = (raw: string): URL | null => {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!isLoopbackHost(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
};

export const localServerKey = (host: string, port: number): string =>
  `${isLoopbackHost(host) ? "loopback" : host.toLowerCase()}:${port}`;

export const urlPort = (url: URL): number =>
  url.port.length > 0 ? Number.parseInt(url.port, 10) : url.protocol === "http:" ? 80 : 443;

export const webProbeCacheKey = (raw: string): string => {
  const url = new URL(raw);
  url.hash = "";
  return url.href;
};

export const normalizeConfiguredUrls = (urls: ReadonlyArray<string>): ReadonlyArray<string> => [
  ...new Set(
    urls
      .slice(0, CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS)
      .filter((raw) => raw.length <= PREVIEW_URL_MAX_LENGTH)
      .map(parseConfiguredUrl)
      .filter((url): url is URL => url !== null && url.href.length <= PREVIEW_URL_MAX_LENGTH)
      .map((url) => {
        if (url.hostname === "0.0.0.0") url.hostname = "localhost";
        return url.href;
      })
      .filter((url) => url.length <= PREVIEW_URL_MAX_LENGTH),
  ),
];

export const projectWebProbeSnapshot = (
  snapshot: WebProbeSnapshot,
  configuredUrls: ReadonlyArray<string>,
): ReadonlyArray<DiscoveredLocalServer> => {
  const visibleByServer = new Map<string, DiscoveredLocalServer>();
  const firstConfiguredByServer = new Map<string, string>();
  for (const raw of normalizeConfiguredUrls(configuredUrls)) {
    const url = new URL(raw);
    const port = urlPort(url);
    const serverKey = localServerKey(url.hostname, port);
    if (!firstConfiguredByServer.has(serverKey)) firstConfiguredByServer.set(serverKey, raw);
    if (visibleByServer.has(serverKey)) continue;
    const configured = snapshot.configured.get(webProbeCacheKey(raw));
    if (configured) visibleByServer.set(serverKey, { ...configured, url: raw });
  }
  // An owned listener whose configured check failed still opens at this caller's configured URL.
  for (const server of snapshot.discovered) {
    const key = localServerKey(server.host, server.port);
    if (visibleByServer.has(key)) continue;
    const configuredUrl = firstConfiguredByServer.get(key);
    visibleByServer.set(key, configuredUrl ? { ...server, url: configuredUrl } : server);
  }
  return [...visibleByServer.values()].toSorted((left, right) => left.port - right.port);
};

export const parseLsofOutput = (
  raw: string,
  owners: ReadonlyMap<number, ServerOwner> = new Map(),
): ReadonlyArray<DiscoveredLocalServer> => {
  const seen = new Map<string, DiscoveredLocalServer>();
  let pid: number | null = null;
  let processName: string | null = null;

  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const tag = line.charAt(0);
    const value = line.slice(1);
    if (tag === "p") {
      const parsed = Number.parseInt(value, 10);
      pid = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      processName = null;
      continue;
    }
    if (tag === "c") {
      processName = value.trim() || null;
      continue;
    }
    if (tag === "n") {
      const portMatch = parsePortFromLsofName(value);
      if (portMatch == null) continue;
      const url = `http://localhost:${portMatch}`;
      const key = `localhost:${portMatch}`;
      const owner = pid === null ? undefined : owners.get(pid);
      const existing = seen.get(key);
      if (existing) {
        if (owner === undefined) seen.set(key, { ...existing, ...UNOWNED });
        continue;
      }
      seen.set(key, {
        host: "localhost",
        port: portMatch,
        url,
        processName,
        pid,
        ...(owner ?? UNOWNED),
      });
    }
  }

  return Array.from(seen.values()).toSorted((a, b) => a.port - b.port);
};

const parsePortFromLsofName = (name: string): number | null => {
  const trimmed = name.split(" ", 1)[0]?.trim() ?? "";
  if (trimmed.length === 0) return null;
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon < 0) return null;
  const hostPart = trimmed.slice(0, lastColon);
  const portPart = trimmed.slice(lastColon + 1);
  if (!LSOF_LOCAL_HOST_TOKENS.has(hostPart)) return null;
  const port = Number.parseInt(portPart, 10);
  if (!Number.isFinite(port) || port <= 0 || port >= 65536) return null;
  return port;
};

export const exitedWithError = (result: ProcessRunner.ProcessRunOutput): boolean =>
  result.code !== null && result.code !== 0;

export const parseTasklistProcessName = (raw: string, pid: number): string | null => {
  for (const line of raw.split(/\r?\n/g)) {
    const match = /^"([^"]*)","(\d+)"/.exec(line.trim());
    if (match && Number(match[2]) === pid) return match[1]!.replace(/\.exe$/i, "") || null;
  }
  return null;
};

export const discoveredWindowsListeners = (
  listeners: ReadonlyArray<WindowsTcpListeners.WindowsTcpListener>,
  owners: ReadonlyMap<number, ServerOwner>,
): ReadonlyArray<DiscoveredLocalServer> => {
  const seen = new Map<number, DiscoveredLocalServer>();
  for (const { port, pid } of listeners) {
    const owner = pid === null ? undefined : owners.get(pid);
    const existing = seen.get(port);
    if (existing) {
      if (owner === undefined) seen.set(port, { ...existing, ...UNOWNED });
      continue;
    }
    seen.set(port, {
      host: "localhost",
      port,
      url: `http://localhost:${port}`,
      processName: null,
      pid,
      ...(owner ?? UNOWNED),
    });
  }
  return [...seen.values()].toSorted((left, right) => left.port - right.port);
};

const PROC_TCP_LISTEN = "0A";

/** Each 32-bit word of the hex address is little-endian. */
const procLocalAddress = (hex: string): boolean => {
  if (hex.length === 8) {
    return hex === "00000000" || hex.endsWith("7F");
  }
  if (hex.length !== 32) return false;
  if (hex === "0".repeat(32) || hex === `${"0".repeat(24)}01000000`) return true;
  return hex.startsWith(`${"0".repeat(16)}FFFF0000`) && procLocalAddress(hex.slice(24));
};

export const parseProcNetTcp = (
  raw: string,
): ReadonlyArray<{ readonly port: number; readonly inode: string }> => {
  const listeners: Array<{ port: number; inode: string }> = [];
  for (const line of raw.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    const [address, portHex] = fields[1]?.split(":") ?? [];
    if (fields[3] !== PROC_TCP_LISTEN || !address || !portHex) continue;
    if (!procLocalAddress(address.toUpperCase())) continue;
    const port = Number.parseInt(portHex, 16);
    const inode = fields[9];
    if (!Number.isInteger(port) || port <= 0 || port >= 65536 || !inode) continue;
    listeners.push({ port, inode });
  }
  return listeners;
};

/** Processes holding a loopback or wildcard listener in `lsof -F pcn` output. */
export const lsofProcessIds = (raw: string): ReadonlyArray<number> => {
  const pids = new Set<number>();
  let pid: number | null = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("p")) {
      const parsed = Number.parseInt(line.slice(1), 10);
      pid = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    } else if (
      line.startsWith("n") &&
      pid !== null &&
      parsePortFromLsofName(line.slice(1)) !== null
    ) {
      pids.add(pid);
    }
  }
  return [...pids];
};

const AGENT_THREAD_ASSIGNMENT = new RegExp(`(?:^|\\s)${AGENT_THREAD_ENV}=(\\S+)`);

/** Reads `/proc/<pid>/environ`, whose entries are NUL-separated. */
export const parseProcEnvironThread = (raw: string): ThreadId | null => {
  const prefix = `${AGENT_THREAD_ENV}=`;
  const value = raw
    .split("\0")
    .find((entry) => entry.startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
  return value ? ThreadId.make(value) : null;
};

/**
 * Reads macOS `ps -E -o pid=,command=`, which appends each process's launch environment to its
 * argv with spaces, so an argument that spells the assignment out also matches.
 */
export const parsePsEnvironmentThreads = (raw: string): ReadonlyMap<number, ThreadId | null> => {
  const threads = new Map<number, ThreadId | null>();
  for (const line of raw.split("\n")) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line);
    if (!match) continue;
    const value = AGENT_THREAD_ASSIGNMENT.exec(match[2]!)?.[1];
    threads.set(Number(match[1]), value ? ThreadId.make(value) : null);
  }
  return threads;
};

export const parseProcessTable = (raw: string): ReadonlyMap<number, ProcessTableRow> => {
  const rows = new Map<number, ProcessTableRow>();
  for (const line of raw.split("\n")) {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(ppid) && Number.isInteger(pgid)) {
      rows.set(pid!, { pid: pid!, ppid: ppid!, pgid: pgid! });
    }
  }
  return rows;
};

/**
 * The process group stopping `pid` signals. Shells with job control and agent tool shells give
 * every job its own group, so the group is the job. Null when the group also holds this server,
 * a direct child of it (agent CLIs and terminal shells), or one of its ancestors.
 */
export const stoppableProcessGroup = (
  table: ReadonlyMap<number, ProcessTableRow>,
  pid: number,
  serverPid: number,
): number | null => {
  const group = table.get(pid)?.pgid;
  if (group === undefined || group <= 1) return null;
  const guarded = new Set([serverPid]);
  for (
    let parent = table.get(serverPid)?.ppid;
    parent !== undefined && parent > 1 && !guarded.has(parent);
    parent = table.get(parent)?.ppid
  ) {
    guarded.add(parent);
  }
  for (const row of table.values()) {
    if (row.pgid === group && (guarded.has(row.pid) || row.ppid === serverPid)) return null;
  }
  return group;
};

export const serversEqual = (
  left: ReadonlyArray<DiscoveredLocalServer>,
  right: ReadonlyArray<DiscoveredLocalServer>,
): boolean => {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i];
    const b = right[i];
    if (!a || !b) return false;
    if (
      a.host !== b.host ||
      a.port !== b.port ||
      a.url !== b.url ||
      a.processName !== b.processName ||
      a.pid !== b.pid ||
      a.terminal?.threadId !== b.terminal?.threadId ||
      a.terminal?.terminalId !== b.terminal?.terminalId ||
      a.agent?.threadId !== b.agent?.threadId
    ) {
      return false;
    }
  }
  return true;
};

export const isNoSuchProcess = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ESRCH";

export const isCommandNotFound = (error: ProcessRunner.ProcessSpawnError): boolean =>
  PlatformError.isPlatformError(error.cause) && error.cause.reason._tag === "NotFound";

/** @public */
import { makePortDiscoveryShape } from "./PortScannerParts2.ts";

export const make = Effect.gen(function* () {
  return PortDiscovery.of(yield* makePortDiscoveryShape);
}).pipe(Effect.withSpan("PortDiscovery.make"));

export const layer = Layer.effect(PortDiscovery, make);

/** A scanner that tracks nothing, for tests that build provider runners without a host. */
export const layerTest = Layer.mock(PortDiscovery)({ trackAgent: () => () => undefined });
export * from "./PortScannerParts2.ts";
