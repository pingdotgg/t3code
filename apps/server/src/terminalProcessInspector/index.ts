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
    const processPidsForPortScan = [terminalPid, ...childPids];
    const runningPorts = await checkWindowsListeningPorts(processPidsForPortScan);
    return {
      hasRunningSubprocess: childPids.length > 0 || runningPorts.length > 0,
      runningPorts,
    };
  }

  const processFamilyPids = await collectPosixProcessFamilyPids(terminalPid);
  if (processFamilyPids.length === 0) {
    return { hasRunningSubprocess: false, runningPorts: [] };
  }

  const subprocessPids = processFamilyPids.filter((pid) => pid !== terminalPid);
  const runningPorts = await checkPosixListeningPorts(processFamilyPids);
  return {
    hasRunningSubprocess: subprocessPids.length > 0 || runningPorts.length > 0,
    runningPorts,
  };
}

export function subprocessCheckerToInspector(
  subprocessChecker: TerminalSubprocessChecker,
): TerminalSubprocessInspector {
  return async (terminalPid: number) => ({
    hasRunningSubprocess: await subprocessChecker(terminalPid),
    runningPorts: [],
  });
}
