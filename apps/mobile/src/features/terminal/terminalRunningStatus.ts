export function countRunningTerminalSessions(
  summaries: ReadonlyArray<{
    readonly hasRunningSubprocess: boolean;
    readonly threadId?: string;
  }>,
  threadId?: string,
): number {
  let count = 0;
  for (const summary of summaries) {
    if ((threadId === undefined || summary.threadId === threadId) && summary.hasRunningSubprocess) {
      count += 1;
    }
  }
  return count;
}

export function terminalRunningSessionLabel(sessionCount: number): string | null {
  if (sessionCount <= 0) {
    return null;
  }
  return sessionCount === 1
    ? "1 terminal has a running process"
    : `${sessionCount} terminals have running processes`;
}
