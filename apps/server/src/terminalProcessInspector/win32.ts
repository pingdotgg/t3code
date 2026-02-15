import { runProcess } from "../processRunner";
import { parsePidList, parsePortList } from "./utils";

export async function collectWindowsChildPids(terminalPid: number): Promise<number[]> {
  const command = [
    `$children = Get-CimInstance Win32_Process -Filter "ParentProcessId = ${terminalPid}" -ErrorAction SilentlyContinue`,
    "if (-not $children) { exit 0 }",
    "$children | Select-Object -ExpandProperty ProcessId",
  ].join("; ");
  try {
    const result = await runProcess(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      {
        timeoutMs: 1_500,
        allowNonZeroExit: true,
        maxBufferBytes: 32_768,
        outputMode: "truncate",
      },
    );
    if (result.code !== 0) {
      return [];
    }
    return parsePidList(result.stdout);
  } catch {
    return [];
  }
}

export async function checkWindowsListeningPorts(processIds: number[]): Promise<number[]> {
  if (processIds.length === 0) return [];

  const processFilter = processIds
    .map((pid) => `$_.OwningProcess -eq ${pid}`)
    .join(" -or ");
  const command = [
    "$connections = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue",
    `$matching = $connections | Where-Object { ${processFilter} }`,
    "if (-not $matching) { exit 0 }",
    "$matching | Select-Object -ExpandProperty LocalPort -Unique",
  ].join("; ");
  try {
    const result = await runProcess(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      {
        timeoutMs: 1_500,
        allowNonZeroExit: true,
        maxBufferBytes: 65_536,
        outputMode: "truncate",
      },
    );
    if (result.code !== 0) {
      return [];
    }
    return parsePortList(result.stdout);
  } catch {
    return [];
  }
}
