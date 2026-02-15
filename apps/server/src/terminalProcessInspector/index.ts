import { collectPosixProcessFamilyPids, checkPosixListeningPorts } from "./posix";
import {
  type TerminalSubprocessActivity,
  type TerminalSubprocessChecker,
  type TerminalSubprocessInspector,
  type TerminalWebPortInspector,
} from "./types";
import { checkWindowsListeningPorts, collectWindowsChildPids } from "./win32";

export {
  arePortListsEqual,
  normalizeRunningPorts,
} from "./utils";

export type {
  TerminalSubprocessActivity,
  TerminalSubprocessChecker,
  TerminalSubprocessInspector,
  TerminalWebPortInspector,
} from "./types";

export async function defaultSubprocessInspector(
  terminalPid: number,
): Promise<TerminalSubprocessActivity> {
  if (!Number.isInteger(terminalPid) || terminalPid <= 0) {
    return { hasRunningSubprocess: false, runningPorts: [] };
  }

  if (process.platform === "win32") {
    const childPids = await collectWindowsChildPids(terminalPid);
    if (childPids.length === 0) {
      return { hasRunningSubprocess: false, runningPorts: [] };
    }
    const runningPorts = await checkWindowsListeningPorts(childPids);
    return { hasRunningSubprocess: true, runningPorts };
  }

  const processFamilyPids = await collectPosixProcessFamilyPids(terminalPid);
  const subprocessPids = processFamilyPids.filter((pid) => pid !== terminalPid);
  if (subprocessPids.length === 0) {
    return { hasRunningSubprocess: false, runningPorts: [] };
  }

  const runningPorts = await checkPosixListeningPorts(subprocessPids);
  return { hasRunningSubprocess: true, runningPorts };
}

export function subprocessCheckerToInspector(
  subprocessChecker: TerminalSubprocessChecker,
): TerminalSubprocessInspector {
  return async (terminalPid: number) => ({
    hasRunningSubprocess: await subprocessChecker(terminalPid),
    runningPorts: [],
  });
}
