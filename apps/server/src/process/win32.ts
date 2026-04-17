import { Effect } from "effect";

import type { TerminalProcessInspectionError } from "./Services/TerminalProcessInspector.ts";
import { parsePidList, parsePortList } from "./utils.ts";

interface InspectorCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

interface WindowsRunCommand {
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

export const collectWindowsChildPids = Effect.fn("process.collectWindowsChildPids")(function* (
  terminalPid: number,
  runCommand: WindowsRunCommand,
): Effect.fn.Return<number[], TerminalProcessInspectionError> {
  const seenPids = new Set<number>([terminalPid]);
  const childPids: number[] = [];
  const pendingParentPids = [terminalPid];

  while (pendingParentPids.length > 0) {
    const parentPid = pendingParentPids.shift();
    if (parentPid === undefined) {
      break;
    }

    const command = [
      `$children = Get-CimInstance Win32_Process -Filter "ParentProcessId = ${parentPid}" -ErrorAction SilentlyContinue`,
      "if (-not $children) { exit 0 }",
      "$children | Select-Object -ExpandProperty ProcessId",
    ].join("; ");
    const result = yield* runCommand({
      operation: "TerminalProcessInspector.collectWindowsChildPids",
      terminalPid,
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", command],
      timeoutMs: 1_500,
      maxOutputBytes: 32_768,
    });
    if (result.exitCode !== 0) {
      continue;
    }

    for (const childPid of parsePidList(result.stdout)) {
      if (seenPids.has(childPid)) {
        continue;
      }
      seenPids.add(childPid);
      childPids.push(childPid);
      pendingParentPids.push(childPid);
    }
  }
  return childPids;
});

export const checkWindowsListeningPorts = Effect.fn("process.checkWindowsListeningPorts")(
  function* (
    processIds: number[],
    input: {
      terminalPid: number;
      runCommand: WindowsRunCommand;
    },
  ): Effect.fn.Return<number[], TerminalProcessInspectionError> {
    if (processIds.length === 0) return [];

    const processFilter = processIds.map((pid) => `$_.OwningProcess -eq ${pid}`).join(" -or ");
    const command = [
      "$connections = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue",
      `$matching = $connections | Where-Object { ${processFilter} }`,
      "if (-not $matching) { exit 0 }",
      "$matching | Select-Object -ExpandProperty LocalPort -Unique",
    ].join("; ");
    const result = yield* input.runCommand({
      operation: "TerminalProcessInspector.checkWindowsListeningPorts",
      terminalPid: input.terminalPid,
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", command],
      timeoutMs: 1_500,
      maxOutputBytes: 65_536,
    });
    if (result.exitCode !== 0) {
      return [];
    }
    return parsePortList(result.stdout);
  },
);
