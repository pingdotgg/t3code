import { Effect } from "effect";

import type { TerminalProcessInspectionError } from "./Services/TerminalProcessInspector.ts";
import { MAX_PORT_NUMBER, portFromAddress } from "./utils.ts";

interface InspectorCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

interface PosixRunCommand {
  (
    input: Readonly<{
      operation: string;
      terminalPid: number;
      command: string;
      args: ReadonlyArray<string>;
      timeoutMs: number;
      maxOutputBytes: number;
    }>,
  ): Effect.Effect<InspectorCommandResult, TerminalProcessInspectionError>;
}

export const collectPosixProcessFamilyPids = Effect.fn("process.collectPosixProcessFamilyPids")(
  function* (
    terminalPid: number,
    runCommand: PosixRunCommand,
  ): Effect.fn.Return<number[], TerminalProcessInspectionError> {
    const psResult = yield* runCommand({
      operation: "TerminalProcessInspector.collectPosixProcessFamilyPids",
      terminalPid,
      command: "ps",
      args: ["-eo", "pid=,ppid="],
      timeoutMs: 1_000,
      maxOutputBytes: 262_144,
    });
    if (psResult.exitCode !== 0) {
      return [];
    }

    const childrenByParentPid = new Map<number, number[]>();
    for (const line of psResult.stdout.split(/\r?\n/g)) {
      const [pidRaw, ppidRaw] = line.trim().split(/\s+/g);
      const pid = Number(pidRaw);
      const ppid = Number(ppidRaw);
      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
      const children = childrenByParentPid.get(ppid);
      if (children) {
        children.push(pid);
      } else {
        childrenByParentPid.set(ppid, [pid]);
      }
    }

    const processFamily = new Set<number>([terminalPid]);
    const pendingParents = [terminalPid];
    while (pendingParents.length > 0) {
      const parentPid = pendingParents.shift();
      if (!parentPid) continue;
      const childPids = childrenByParentPid.get(parentPid);
      if (!childPids || childPids.length === 0) continue;
      for (const childPid of childPids) {
        if (processFamily.has(childPid)) continue;
        processFamily.add(childPid);
        pendingParents.push(childPid);
      }
    }

    return [...processFamily];
  },
);

export const checkPosixListeningPorts = Effect.fn("process.checkPosixListeningPorts")(function* (
  processIds: number[],
  input: {
    terminalPid: number;
    runCommand: PosixRunCommand;
    platform?: NodeJS.Platform;
  },
): Effect.fn.Return<number[], TerminalProcessInspectionError> {
  if (processIds.length === 0) return [];

  const ports = new Set<number>();
  const pidFilter = new Set(processIds);
  const platform = input.platform ?? process.platform;

  const lsofResult = yield* input
    .runCommand({
      operation: "TerminalProcessInspector.checkPosixListeningPorts.lsof",
      terminalPid: input.terminalPid,
      command: "lsof",
      args: ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", processIds.join(",")],
      timeoutMs: 1_500,
      maxOutputBytes: 262_144,
    })
    .pipe(Effect.exit);

  if (lsofResult._tag === "Success") {
    if (lsofResult.value.exitCode === 0) {
      for (const line of lsofResult.value.stdout.split(/\r?\n/g)) {
        const match = line.match(/:(\d+)\s+\(LISTEN\)$/);
        if (!match?.[1]) continue;
        const port = Number(match[1]);
        if (Number.isInteger(port) && port > 0 && port <= MAX_PORT_NUMBER) {
          ports.add(port);
        }
      }
      return [...ports].toSorted((left, right) => left - right);
    }
    if (lsofResult.value.exitCode === 1 && platform === "darwin") {
      return [];
    }
  }

  const ssResult = yield* input.runCommand({
    operation: "TerminalProcessInspector.checkPosixListeningPorts.ss",
    terminalPid: input.terminalPid,
    command: "ss",
    args: ["-ltnp"],
    timeoutMs: 1_500,
    maxOutputBytes: 524_288,
  });
  if (ssResult.exitCode !== 0) {
    return [];
  }

  for (const line of ssResult.stdout.split(/\r?\n/g)) {
    if (!line.includes("pid=")) continue;
    const localAddress = line.trim().split(/\s+/g)[3];
    if (!localAddress) continue;
    const port = portFromAddress(localAddress);
    if (port === null) continue;

    const pidMatches = [...line.matchAll(/pid=(\d+)/g)];
    if (pidMatches.length === 0) continue;
    if (
      pidMatches.some((match) => {
        const pid = Number(match[1]);
        return Number.isInteger(pid) && pidFilter.has(pid);
      })
    ) {
      ports.add(port);
    }
  }
  return [...ports].toSorted((left, right) => left - right);
});
