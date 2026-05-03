/**
 * In-process PortScanner implementation.
 *
 * macOS/Linux: parses `lsof -iTCP -sTCP:LISTEN -P -n -F pcn` (-F output is a
 * stable line-prefixed field format; this is the only `lsof` flag set we rely
 * on).
 *
 * Windows / lsof missing: TCP-connects to a curated list of common dev ports
 * on 127.0.0.1.
 *
 * Polling is reference-counted via `retain()`. A single layer-scoped fiber
 * polls forever, but each tick is a no-op when the retain count is zero.
 */
import * as net from "node:net";

import type { DiscoveredLocalServer } from "@t3tools/contracts";
import { LSOF_LOCAL_HOST_TOKENS } from "@t3tools/shared/preview";
import { Cause, Data, Duration, Effect, Layer, Ref, Schedule } from "effect";

import { runProcess } from "../../processRunner.ts";
import {
  COMMON_DEV_PORTS,
  PreviewPortScanner,
  type PreviewPortScannerShape,
} from "../Services/PortScanner.ts";

const POLL_INTERVAL = Duration.seconds(3);
const TCP_PROBE_TIMEOUT_MS = 200;
const LSOF_TIMEOUT_MS = 5_000;

type Listener = (servers: ReadonlyArray<DiscoveredLocalServer>) => Effect.Effect<void>;

class LsofProbeError extends Data.TaggedError("LsofProbeError")<{
  readonly cause: unknown;
}> {}

interface ScannerState {
  readonly lastSnapshot: ReadonlyArray<DiscoveredLocalServer>;
}

const parseLsofOutput = (raw: string): ReadonlyArray<DiscoveredLocalServer> => {
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
      if (seen.has(key)) continue;
      seen.set(key, {
        host: "localhost",
        port: portMatch,
        url,
        processName,
        pid,
      });
    }
  }

  return Array.from(seen.values()).toSorted((a, b) => a.port - b.port);
};

const parsePortFromLsofName = (name: string): number | null => {
  // Examples: "*:5173", "127.0.0.1:5173", "[::1]:5173", "localhost:5173",
  //           "192.168.1.10:5173 (LISTEN)" — we only care if the host part is local.
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

const probeLsof = (): Effect.Effect<ReadonlyArray<DiscoveredLocalServer> | null> =>
  Effect.tryPromise({
    try: () =>
      runProcess("lsof", ["-iTCP", "-sTCP:LISTEN", "-P", "-n", "-F", "pcn"], {
        timeoutMs: LSOF_TIMEOUT_MS,
        allowNonZeroExit: true,
        maxBufferBytes: 1024 * 1024,
        outputMode: "truncate",
      }),
    catch: (cause) => new LsofProbeError({ cause }),
  }).pipe(
    Effect.map((result) => parseLsofOutput(result.stdout)),
    Effect.catch(() => Effect.succeed(null)),
  );

const probeTcpPort = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(TCP_PROBE_TIMEOUT_MS);
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.once("connect", () => finish(true));
    socket.connect({ host: "127.0.0.1", port });
  });

const probeCommonPorts = (): Effect.Effect<ReadonlyArray<DiscoveredLocalServer>> =>
  Effect.promise(async () => {
    const results = await Promise.all(
      COMMON_DEV_PORTS.map(async (port) => ({ port, listening: await probeTcpPort(port) })),
    );
    return results
      .filter((r) => r.listening)
      .map<DiscoveredLocalServer>((r) => ({
        host: "localhost",
        port: r.port,
        url: `http://localhost:${r.port}`,
        processName: null,
        pid: null,
      }));
  });

const serversEqual = (
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
      a.pid !== b.pid
    ) {
      return false;
    }
  }
  return true;
};

export const makePreviewPortScanner = Effect.gen(function* () {
  const stateRef = yield* Ref.make<ScannerState>({
    lastSnapshot: [],
  });
  const listeners = new Set<Listener>();
  // Plain integer because the release callback returned by `retain()` runs
  // outside any Effect context (the WS subscriber's release path) and must
  // be a synchronous side-effect-only function.
  let retainCount = 0;

  const scanOnce = (): Effect.Effect<ReadonlyArray<DiscoveredLocalServer>> =>
    Effect.gen(function* () {
      if (process.platform === "win32") {
        return yield* probeCommonPorts();
      }
      const lsof = yield* probeLsof();
      if (lsof !== null) return lsof;
      return yield* probeCommonPorts();
    });

  const broadcast = (servers: ReadonlyArray<DiscoveredLocalServer>): Effect.Effect<void> =>
    Effect.forEach(Array.from(listeners), (listener) => listener(servers), { discard: true });

  const pollTick = Effect.gen(function* () {
    if (retainCount <= 0) return;
    const next = yield* scanOnce();
    const state = yield* Ref.get(stateRef);
    if (serversEqual(state.lastSnapshot, next)) return;
    yield* Ref.update(stateRef, (s) => ({ ...s, lastSnapshot: next }));
    yield* broadcast(next);
  }).pipe(
    Effect.catchCause((cause: Cause.Cause<never>) =>
      Effect.logWarning("preview port scan failed", Cause.pretty(cause)),
    ),
  );

  // Single layer-scoped polling fiber. Ticks are no-ops when no client is
  // currently retained, so the cost is one Ref.get every POLL_INTERVAL.
  yield* Effect.forkScoped(pollTick.pipe(Effect.repeat(Schedule.spaced(POLL_INTERVAL))));

  const retain: PreviewPortScannerShape["retain"] = () =>
    Effect.gen(function* () {
      const wasIdle = retainCount === 0;
      retainCount += 1;
      if (wasIdle) {
        // Run an immediate scan + broadcast so the new retainer doesn't have
        // to wait up to POLL_INTERVAL for the first emission.
        yield* pollTick;
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        retainCount = Math.max(0, retainCount - 1);
      };
    });

  const subscribe: PreviewPortScannerShape["subscribe"] = (listener) =>
    Effect.sync(() => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    });

  return {
    scan: scanOnce,
    subscribe,
    retain,
  } satisfies PreviewPortScannerShape;
});

export const PreviewPortScannerLive = Layer.effect(PreviewPortScanner, makePreviewPortScanner);

/** Exposed for tests. */
export const __testing = {
  parseLsofOutput,
  parsePortFromLsofName,
  serversEqual,
};
