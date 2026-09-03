export const TERMINAL_RUNNING_ACCESSIBILITY_LABEL = "Terminal process running";

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

export function terminalActionAccessibilityLabel(sessionCount: number): string {
  const runningLabel = terminalRunningSessionLabel(sessionCount);
  return runningLabel === null ? "Open terminal" : `Open terminal, ${runningLabel}`;
}

export function threadRunningIndicatorPlacement(input: {
  readonly variant: "v1" | "card" | "slim";
  readonly hasRunningTerminal: boolean;
}): "metadata" | "trailing" | null {
  if (!input.hasRunningTerminal) {
    return null;
  }
  return input.variant === "slim" ? "trailing" : "metadata";
}

export function threadRunningAccessibilityLabel(input: {
  readonly title: string;
  readonly detail?: string | null;
  readonly hasRunningTerminal: boolean;
}): string {
  return [
    input.title,
    input.detail,
    input.hasRunningTerminal ? TERMINAL_RUNNING_ACCESSIBILITY_LABEL : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(", ");
}
