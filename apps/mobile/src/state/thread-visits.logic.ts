import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { AppStateStatus } from "react-native";

export function shouldMarkThreadVisited(props: {
  readonly appState: AppStateStatus;
  readonly isFocused: boolean;
}): boolean {
  return props.appState === "active" && props.isFocused;
}

export function markThreadVisited(
  current: Readonly<Record<string, string>>,
  threadKey: string,
  visitedAt: string,
): Readonly<Record<string, string>> {
  const visitedAtMs = Date.parse(visitedAt);
  if (Number.isNaN(visitedAtMs)) return current;

  const previous = current[threadKey];
  const previousMs = previous === undefined ? Number.NaN : Date.parse(previous);
  if (!Number.isNaN(previousMs) && previousMs >= visitedAtMs) return current;

  return { ...current, [threadKey]: visitedAt };
}

export function resolveOpenThreadVisitedAt(
  thread: Pick<EnvironmentThreadShell, "createdAt" | "latestTurn" | "updatedAt">,
): string {
  const candidates = [
    thread.latestTurn?.completedAt,
    thread.latestTurn?.startedAt,
    thread.latestTurn?.requestedAt,
    thread.updatedAt,
    thread.createdAt,
  ];
  for (const candidate of candidates) {
    if (candidate !== null && candidate !== undefined && !Number.isNaN(Date.parse(candidate))) {
      return candidate;
    }
  }
  return thread.createdAt;
}
