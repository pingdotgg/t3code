import type {
  ServerProcessDiagnosticsEntry,
  ServerProcessDiagnosticsResult,
  ServerProcessSignal,
  ServerSignalProcessResult,
} from "@t3tools/contracts";
import { Effect, Schema } from "effect";

import { runProcess } from "../processRunner.ts";

interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number | null;
  readonly status: string;
  readonly cpuPercent: number;
  readonly rssBytes: number;
  readonly elapsed: string;
  readonly command: string;
}

const PROCESS_QUERY_TIMEOUT_MS = 1_000;
const POSIX_PROCESS_QUERY_COMMAND = "pid=,ppid=,pgid=,stat=,pcpu=,rss=,etime=,command=";

class ProcessDiagnosticsError extends Schema.TaggedErrorClass<ProcessDiagnosticsError>()(
  "ProcessDiagnosticsError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

function toProcessDiagnosticsError(message: string, cause?: unknown): ProcessDiagnosticsError {
  return new ProcessDiagnosticsError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function parsePositiveInt(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseNonNegativeInt(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseNumber(value: string): number | null {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parsePosixProcessRows(output: string): ReadonlyArray<ProcessRow> {
  const rows: ProcessRow[] = [];
  const rowPattern =
    /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+([+-]?(?:\d+\.?\d*|\.\d+))\s+(\d+)\s+(\S+)\s+(.+)$/;

  for (const line of output.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;

    const match = rowPattern.exec(line);
    if (!match) continue;

    const pidText = match[1];
    const ppidText = match[2];
    const pgidText = match[3];
    const status = match[4];
    const cpuText = match[5];
    const rssText = match[6];
    const elapsed = match[7];
    const command = match[8];
    if (
      pidText === undefined ||
      ppidText === undefined ||
      pgidText === undefined ||
      status === undefined ||
      cpuText === undefined ||
      rssText === undefined ||
      elapsed === undefined ||
      command === undefined
    ) {
      continue;
    }

    const pid = parsePositiveInt(pidText);
    const ppid = parseNonNegativeInt(ppidText);
    const pgid = Number.parseInt(pgidText, 10);
    const cpuPercent = parseNumber(cpuText);
    const rssKiB = parseNonNegativeInt(rssText);
    if (
      pid === null ||
      ppid === null ||
      !Number.isInteger(pgid) ||
      cpuPercent === null ||
      rssKiB === null ||
      !status ||
      !elapsed ||
      !command
    ) {
      continue;
    }

    rows.push({
      pid,
      ppid,
      pgid,
      status,
      cpuPercent,
      rssBytes: rssKiB * 1024,
      elapsed,
      command,
    });
  }

  return rows;
}

function normalizeWindowsProcessRow(value: unknown): ProcessRow | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const pid = typeof record.ProcessId === "number" ? record.ProcessId : null;
  const ppid = typeof record.ParentProcessId === "number" ? record.ParentProcessId : null;
  const commandLine =
    typeof record.CommandLine === "string" && record.CommandLine.trim().length > 0
      ? record.CommandLine
      : typeof record.Name === "string"
        ? record.Name
        : null;
  const workingSet =
    typeof record.WorkingSetSize === "number" && Number.isFinite(record.WorkingSetSize)
      ? Math.max(0, Math.round(record.WorkingSetSize))
      : 0;
  const cpuPercent =
    typeof record.PercentProcessorTime === "number" && Number.isFinite(record.PercentProcessorTime)
      ? Math.max(0, record.PercentProcessorTime)
      : 0;

  if (!pid || pid <= 0 || ppid === null || ppid < 0 || !commandLine) return null;
  return {
    pid,
    ppid,
    pgid: null,
    status: typeof record.Status === "string" && record.Status.length > 0 ? record.Status : "Live",
    cpuPercent,
    rssBytes: workingSet,
    elapsed: "",
    command: commandLine,
  };
}

function parseWindowsProcessRows(output: string): ReadonlyArray<ProcessRow> {
  if (output.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(output) as unknown;
    const records = Array.isArray(parsed) ? parsed : [parsed];
    return records.flatMap((record) => {
      const row = normalizeWindowsProcessRow(record);
      return row ? [row] : [];
    });
  } catch {
    return [];
  }
}

function buildDescendantEntries(
  rows: ReadonlyArray<ProcessRow>,
  serverPid: number,
): ReadonlyArray<ServerProcessDiagnosticsEntry> {
  const childrenByParent = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const children = childrenByParent.get(row.ppid) ?? [];
    children.push(row);
    childrenByParent.set(row.ppid, children);
  }

  const entries: ServerProcessDiagnosticsEntry[] = [];
  const visited = new Set<number>();
  const stack = [...(childrenByParent.get(serverPid) ?? [])]
    .toSorted((left, right) => left.pid - right.pid)
    .map((row) => ({ row, depth: 0 }));

  while (stack.length > 0) {
    const item = stack.shift();
    if (!item || visited.has(item.row.pid)) continue;
    visited.add(item.row.pid);

    const children = [...(childrenByParent.get(item.row.pid) ?? [])].toSorted(
      (left, right) => left.pid - right.pid,
    );
    entries.push({
      pid: item.row.pid,
      ppid: item.row.ppid,
      pgid: item.row.pgid,
      status: item.row.status,
      cpuPercent: item.row.cpuPercent,
      rssBytes: item.row.rssBytes,
      elapsed: item.row.elapsed || "n/a",
      command: item.row.command,
      depth: item.depth,
      childPids: children.map((child) => child.pid),
    });

    stack.unshift(...children.map((row) => ({ row, depth: item.depth + 1 })).toReversed());
  }

  return entries;
}

function isDiagnosticsQueryProcess(row: ProcessRow, serverPid: number): boolean {
  if (row.ppid !== serverPid) return false;

  const command = row.command.trim();
  return (
    /(?:^|[/\\])ps\s+-axo\s+pid=,ppid=,pgid=,stat=,pcpu=,rss=,etime=,command=/.test(command) ||
    (/\bpowershell(?:\.exe)?\b/i.test(command) &&
      /\bGet-CimInstance\s+Win32_Process\b/i.test(command))
  );
}

function makeResult(input: {
  readonly serverPid: number;
  readonly rows: ReadonlyArray<ProcessRow>;
  readonly readAt?: Date;
  readonly error?: string;
}): ServerProcessDiagnosticsResult {
  const readAt = input.readAt ?? new Date();
  const rows = input.rows.filter((row) => !isDiagnosticsQueryProcess(row, input.serverPid));
  const processes = buildDescendantEntries(rows, input.serverPid);
  const totalRssBytes = processes.reduce((total, process) => total + process.rssBytes, 0);
  const totalCpuPercent = processes.reduce((total, process) => total + process.cpuPercent, 0);

  return {
    serverPid: input.serverPid,
    readAt: readAt.toISOString(),
    processCount: processes.length,
    totalRssBytes,
    totalCpuPercent,
    processes,
    ...(input.error ? { error: { message: input.error } } : {}),
  };
}

function readPosixProcessRows(): Effect.Effect<ReadonlyArray<ProcessRow>, ProcessDiagnosticsError> {
  return Effect.tryPromise({
    try: async () => {
      const result = await runProcess("ps", ["-axo", POSIX_PROCESS_QUERY_COMMAND], {
        timeoutMs: PROCESS_QUERY_TIMEOUT_MS,
        allowNonZeroExit: true,
        maxBufferBytes: 2 * 1024 * 1024,
        outputMode: "truncate",
      });
      if (result.code !== 0) {
        throw toProcessDiagnosticsError(result.stderr.trim() || "ps failed.");
      }
      return parsePosixProcessRows(result.stdout);
    },
    catch: (cause) =>
      Schema.is(ProcessDiagnosticsError)(cause)
        ? cause
        : toProcessDiagnosticsError("Failed to query process diagnostics.", cause),
  });
}

function readWindowsProcessRows(): Effect.Effect<
  ReadonlyArray<ProcessRow>,
  ProcessDiagnosticsError
> {
  const command = [
    "$processes = Get-CimInstance Win32_Process | ForEach-Object {",
    '$perf = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter "IDProcess = $($_.ProcessId)" -ErrorAction SilentlyContinue;',
    "[pscustomobject]@{ ProcessId = $_.ProcessId; ParentProcessId = $_.ParentProcessId; Name = $_.Name; CommandLine = $_.CommandLine; Status = $_.Status; WorkingSetSize = $_.WorkingSetSize; PercentProcessorTime = if ($perf) { $perf.PercentProcessorTime } else { 0 } }",
    "};",
    "$processes | ConvertTo-Json -Compress -Depth 3",
  ].join(" ");

  return Effect.tryPromise({
    try: async () => {
      const result = await runProcess(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        {
          timeoutMs: PROCESS_QUERY_TIMEOUT_MS,
          allowNonZeroExit: true,
          maxBufferBytes: 2 * 1024 * 1024,
          outputMode: "truncate",
        },
      );
      if (result.code !== 0) {
        throw toProcessDiagnosticsError(result.stderr.trim() || "PowerShell process query failed.");
      }
      return parseWindowsProcessRows(result.stdout);
    },
    catch: (cause) =>
      Schema.is(ProcessDiagnosticsError)(cause)
        ? cause
        : toProcessDiagnosticsError("Failed to query process diagnostics.", cause),
  });
}

function readProcessRows(): Effect.Effect<ReadonlyArray<ProcessRow>, ProcessDiagnosticsError> {
  return process.platform === "win32" ? readWindowsProcessRows() : readPosixProcessRows();
}

export function aggregateProcessDiagnostics(input: {
  readonly serverPid: number;
  readonly rows: ReadonlyArray<ProcessRow>;
  readonly readAt?: Date;
}): ServerProcessDiagnosticsResult {
  return makeResult(input);
}

export function readProcessDiagnostics(): Effect.Effect<ServerProcessDiagnosticsResult> {
  const serverPid = process.pid;
  return readProcessRows().pipe(
    Effect.map((rows) => makeResult({ serverPid, rows })),
    Effect.catch((error: ProcessDiagnosticsError) =>
      Effect.succeed(makeResult({ serverPid, rows: [], error: error.message })),
    ),
  );
}

function assertDescendantPid(pid: number): Effect.Effect<void, ProcessDiagnosticsError> {
  if (pid === process.pid) {
    return Effect.fail(toProcessDiagnosticsError("Refusing to signal the T3 server process."));
  }

  return readProcessRows().pipe(
    Effect.flatMap((rows) => {
      const descendant = buildDescendantEntries(rows, process.pid).some(
        (entry) => entry.pid === pid,
      );
      return descendant
        ? Effect.void
        : Effect.fail(
            toProcessDiagnosticsError(`Process ${pid} is not a live descendant of the T3 server.`),
          );
    }),
  );
}

export function signalProcess(input: {
  readonly pid: number;
  readonly signal: ServerProcessSignal;
}): Effect.Effect<ServerSignalProcessResult> {
  return assertDescendantPid(input.pid).pipe(
    Effect.flatMap(() =>
      Effect.try({
        try: () => {
          process.kill(input.pid, input.signal);
          return {
            pid: input.pid,
            signal: input.signal,
            signaled: true,
          };
        },
        catch: (cause) =>
          toProcessDiagnosticsError(
            `Failed to signal process ${input.pid} with ${input.signal}.`,
            cause,
          ),
      }),
    ),
    Effect.catch((error: ProcessDiagnosticsError) =>
      Effect.succeed({
        pid: input.pid,
        signal: input.signal,
        signaled: false,
        message: error.message,
      }),
    ),
  );
}
