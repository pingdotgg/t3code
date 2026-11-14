import { LSOF_LOCAL_HOST_TOKENS } from "@t3tools/shared/preview";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import type * as ProcessRunner from "../processRunner.ts";

const NETSTAT_TIMEOUT = Duration.seconds(5);
/** `netstat -ano` lists every connection, not just listeners; ~80 bytes per row, sized for ~200k rows. */
const NETSTAT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface WindowsTcpListener {
  readonly port: number;
  readonly pid: number | null;
}

const parseWindowsTcpListenerLine = (line: string): WindowsTcpListener | null => {
  // Foreign port `:0` identifies a listening TCP socket regardless of Windows locale.
  const fields = line.trim().split(/\s+/);
  if (fields.length < 4 || fields[0]?.toUpperCase() !== "TCP") return null;
  const localEndpoint = fields[1] ?? "";
  const foreignEndpoint = fields[2] ?? "";
  if (!foreignEndpoint.endsWith(":0")) return null;
  const lastColon = localEndpoint.lastIndexOf(":");
  if (lastColon <= 0) return null;
  const host = localEndpoint.slice(0, lastColon);
  if (!LSOF_LOCAL_HOST_TOKENS.has(host) && host !== "::") return null;
  const port = Number(localEndpoint.slice(lastColon + 1));
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) return null;
  const pid = Number(fields.at(-1));
  return { port, pid: Number.isInteger(pid) && pid > 0 ? pid : null };
};

const parseWindowsTcpListeners = (raw: string): ReadonlyArray<WindowsTcpListener> =>
  raw.split(/\r?\n/g).flatMap((line) => {
    const listener = parseWindowsTcpListenerLine(line);
    return listener === null ? [] : [listener];
  });

const exitedWithError = (result: ProcessRunner.ProcessRunOutput): boolean =>
  result.code !== null && result.code !== 0;

/** Resolves to `null` when either query exits nonzero. */
export const queryWindowsTcpListeners = Effect.fn("windowsTcpListeners.query")(function* (
  processRunner: ProcessRunner.ProcessRunner["Service"],
  netstatCommand: string,
) {
  const runNetstat = (protocol: "tcp" | "tcpv6") =>
    processRunner.run({
      command: netstatCommand,
      args: ["-ano", "-p", protocol],
      timeout: NETSTAT_TIMEOUT,
      maxOutputBytes: NETSTAT_MAX_OUTPUT_BYTES,
    });
  const [tcp4, tcp6] = yield* Effect.all([runNetstat("tcp"), runNetstat("tcpv6")], {
    concurrency: 2,
  });
  // One failed query leaves a partial snapshot that could hide another process sharing a
  // port across IPv4/IPv6.
  if (exitedWithError(tcp4) || exitedWithError(tcp6)) return null;
  return parseWindowsTcpListeners(`${tcp4.stdout}\n${tcp6.stdout}`);
});
