export type ThreadHeaderStatusKind = "approval" | "input" | "working" | "failed" | "done";

export interface ThreadHeaderStatusPresentation {
  readonly kind: ThreadHeaderStatusKind;
  readonly label: string;
  readonly nativeLabel: string;
  readonly tintColor: string;
}

export function formatThreadHeaderElapsed(startedAt: string | null, nowMs: number): string | null {
  if (!startedAt) {
    return null;
  }
  const startedAtMs = Date.parse(startedAt);
  if (Number.isNaN(startedAtMs)) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function resolveThreadHeaderStatus(input: {
  readonly hasPendingApproval: boolean;
  readonly hasPendingUserInput: boolean;
  readonly active: boolean;
  readonly failed: boolean;
  readonly activeWorkStartedAt: string | null;
  readonly nowMs: number;
}): ThreadHeaderStatusPresentation {
  if (input.hasPendingApproval) {
    return {
      kind: "approval",
      label: "Approval",
      nativeLabel: "Approval",
      tintColor: "#ffd60a",
    };
  }
  if (input.hasPendingUserInput) {
    return {
      kind: "input",
      label: "Input",
      nativeLabel: "Input",
      tintColor: "#7d7aff",
    };
  }
  if (input.active) {
    const elapsed = formatThreadHeaderElapsed(input.activeWorkStartedAt, input.nowMs);
    return {
      kind: "working",
      label: elapsed ?? "Working",
      nativeLabel: elapsed ?? "Working",
      tintColor: "#0a84ff",
    };
  }
  if (input.failed) {
    return {
      kind: "failed",
      label: "Failed",
      nativeLabel: "Failed",
      tintColor: "#f87171",
    };
  }
  return {
    kind: "done",
    label: "Done",
    nativeLabel: "Done",
    tintColor: "#30d158",
  };
}
