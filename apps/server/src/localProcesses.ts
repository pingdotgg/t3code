import type {
  LocalProcessProbePortsInput,
  LocalProcessProbePortsResult,
  LocalProcessStopPortsInput,
  LocalProcessStopPortsResult,
} from "@t3tools/contracts";

import { runProcess } from "./processRunner.ts";

const PORT_LOOKUP_TIMEOUT_MS = 2_000;
const PORT_LOOKUP_MAX_BUFFER_BYTES = 64 * 1024;

export interface LocalProcessControls {
  readonly listListeningPids: (port: number) => Promise<readonly number[]>;
  readonly killPid: (pid: number) => Promise<void> | void;
  readonly currentPid: number;
}

export function parseListeningPidList(text: string): number[] {
  const seen = new Set<number>();
  for (const token of text.split(/\s+/u)) {
    if (!/^\d+$/u.test(token)) {
      continue;
    }
    const pid = Number(token);
    if (Number.isSafeInteger(pid) && pid > 0) {
      seen.add(pid);
    }
  }
  return [...seen];
}

function normalizePorts(
  input: LocalProcessStopPortsInput | LocalProcessProbePortsInput,
  maxCount: number,
): number[] {
  const seen = new Set<number>();
  for (const port of input.ports) {
    if (Number.isInteger(port) && port >= 1 && port <= 65_535) {
      seen.add(port);
    }
  }
  return [...seen].slice(0, maxCount);
}

async function listListeningPidsWithLsof(port: number): Promise<number[]> {
  const result = await runProcess("lsof", ["-nP", "-ti", `TCP:${port}`, "-sTCP:LISTEN"], {
    allowNonZeroExit: true,
    maxBufferBytes: PORT_LOOKUP_MAX_BUFFER_BYTES,
    outputMode: "truncate",
    timeoutMs: PORT_LOOKUP_TIMEOUT_MS,
  });
  return parseListeningPidList(result.stdout);
}

async function listListeningPidsWithPowerShell(port: number): Promise<number[]> {
  const command = [
    "Get-NetTCPConnection",
    `-LocalPort ${port}`,
    "-State Listen",
    "-ErrorAction SilentlyContinue",
    "| Select-Object -ExpandProperty OwningProcess -Unique",
  ].join(" ");
  const result = await runProcess(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    {
      allowNonZeroExit: true,
      maxBufferBytes: PORT_LOOKUP_MAX_BUFFER_BYTES,
      outputMode: "truncate",
      timeoutMs: PORT_LOOKUP_TIMEOUT_MS,
    },
  );
  return parseListeningPidList(result.stdout);
}

async function listListeningPids(port: number): Promise<number[]> {
  if (process.platform === "win32") {
    return listListeningPidsWithPowerShell(port);
  }
  return listListeningPidsWithLsof(port);
}

function killPid(pid: number): void {
  process.kill(pid, "SIGTERM");
}

export const defaultLocalProcessControls: LocalProcessControls = {
  currentPid: process.pid,
  listListeningPids,
  killPid,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function probeLocalPorts(
  input: LocalProcessProbePortsInput,
  controls: LocalProcessControls = defaultLocalProcessControls,
): Promise<LocalProcessProbePortsResult> {
  const ports = normalizePorts(input, 32);
  const results = await Promise.all(
    ports.map(async (port) => {
      try {
        const pids = await controls.listListeningPids(port);
        const filteredPids = [...new Set(pids)].filter(
          (pid) => Number.isSafeInteger(pid) && pid > 0,
        );
        return {
          port,
          isListening: filteredPids.length > 0,
          pids: filteredPids,
          error: null,
        };
      } catch (error) {
        return {
          port,
          isListening: false,
          pids: [] as number[],
          error: errorMessage(error),
        };
      }
    }),
  );
  return { results };
}

export async function stopLocalPorts(
  input: LocalProcessStopPortsInput,
  controls: LocalProcessControls = defaultLocalProcessControls,
): Promise<LocalProcessStopPortsResult> {
  const results: Array<{ port: number; killedPids: number[]; errors: string[] }> = [];

  for (const port of normalizePorts(input, 16)) {
    const errors: string[] = [];
    let pids: readonly number[] = [];

    try {
      pids = await controls.listListeningPids(port);
    } catch (error) {
      errors.push(`Failed to inspect port ${port}: ${errorMessage(error)}`);
    }

    const killedPids: number[] = [];
    for (const pid of new Set(pids)) {
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        continue;
      }
      if (pid === controls.currentPid) {
        errors.push(`Refusing to stop the current T3 Code process on port ${port}.`);
        continue;
      }
      try {
        await controls.killPid(pid);
        killedPids.push(pid);
      } catch (error) {
        const code =
          error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : "";
        if (code !== "ESRCH") {
          errors.push(`Failed to stop process ${pid} on port ${port}: ${errorMessage(error)}`);
        }
      }
    }

    results.push({ port, killedPids, errors });
  }

  return { results };
}
