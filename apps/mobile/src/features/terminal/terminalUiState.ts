import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

export interface TerminalGridSize {
  readonly cols: number;
  readonly rows: number;
}

export interface TerminalUiStateTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly terminalId: string;
}

const terminalGridSizeCache = new Map<string, TerminalGridSize>();

function terminalUiStateKey(target: TerminalUiStateTarget): string {
  return `${target.environmentId}:${target.threadId}:${target.terminalId}`;
}

export function getCachedTerminalGridSize(target: TerminalUiStateTarget): TerminalGridSize | null {
  return terminalGridSizeCache.get(terminalUiStateKey(target)) ?? null;
}

export function cacheTerminalGridSize(
  target: TerminalUiStateTarget,
  size: TerminalGridSize,
): TerminalGridSize {
  const normalized = {
    cols: Math.max(1, Math.floor(size.cols)),
    rows: Math.max(1, Math.floor(size.rows)),
  };
  terminalGridSizeCache.set(terminalUiStateKey(target), normalized);
  return normalized;
}

export function resetTerminalUiStateCaches() {
  terminalGridSizeCache.clear();
}
