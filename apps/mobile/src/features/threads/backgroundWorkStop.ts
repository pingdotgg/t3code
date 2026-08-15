import type {
  CommandId,
  OrchestrationThread,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { satisfiesSemverRange } from "@t3tools/shared/semver";

interface BackgroundWorkStopOutcome {
  readonly title: string;
  readonly message: string;
}

interface BackgroundWorkStopGuardOptions {
  readonly timeoutMs?: number;
  readonly onTimeout?: (outcome: BackgroundWorkStopOutcome) => void;
}

interface PendingBackgroundWorkStop {
  timeout: ReturnType<typeof setTimeout> | null;
}

export function createBackgroundWorkStopGuard(
  onPendingCommandChange: (commandId: CommandId | null) => void,
  options?: BackgroundWorkStopGuardOptions,
) {
  let pending: PendingBackgroundWorkStop | null = null;
  const resolveAttempt = (attempt: PendingBackgroundWorkStop) => {
    if (pending !== attempt) {
      return;
    }
    pending = null;
    if (attempt.timeout !== null) {
      clearTimeout(attempt.timeout);
    }
    onPendingCommandChange(null);
  };
  return {
    resolve: () => {
      if (pending !== null) {
        resolveAttempt(pending);
      }
    },
    run: async (
      commandId: CommandId,
      interrupt: (attempt: { readonly resolve: () => void }) => Promise<unknown>,
    ) => {
      if (pending !== null) {
        return false;
      }
      const attempt: PendingBackgroundWorkStop = { timeout: null };
      pending = attempt;
      onPendingCommandChange(commandId);
      attempt.timeout = setTimeout(() => {
        if (pending !== attempt) {
          return;
        }
        resolveAttempt(attempt);
        options?.onTimeout?.({
          title: "Stop status unknown",
          message:
            "This server did not confirm whether background work stopped. Check the thread before trying again.",
        });
      }, options?.timeoutMs ?? 5_000);
      try {
        await interrupt({ resolve: () => resolveAttempt(attempt) });
        return true;
      } catch (error) {
        resolveAttempt(attempt);
        throw error;
      }
    },
  };
}

export function backgroundWorkStopConfirmation(onConfirm: () => void) {
  return {
    title: "Stop background work?",
    message: "This interrupts any active turn and its background agents.",
    actions: [
      { text: "Cancel", style: "cancel" as const },
      { text: "Stop", style: "destructive" as const, onPress: onConfirm },
    ],
  };
}

export function buildBackgroundWorkInterruptInput(
  thread: Pick<OrchestrationThread, "id" | "session">,
  commandId: CommandId,
  serverVersion: string | null,
) {
  const supportsGuardedInterrupt =
    serverVersion !== null && satisfiesSemverRange(serverVersion, ">=0.0.33");
  if (supportsGuardedInterrupt && thread.session?.status === "starting") {
    return null;
  }
  const runningTurnId = thread.session?.status === "running" ? thread.session.activeTurnId : null;
  return {
    threadId: thread.id,
    commandId,
    ...(runningTurnId !== null ? { turnId: runningTurnId } : {}),
    ...(supportsGuardedInterrupt
      ? {
          expectedTurnId: thread.session?.activeTurnId ?? null,
          ...(thread.session !== null
            ? { expectedSessionUpdatedAt: thread.session.updatedAt }
            : {}),
        }
      : {}),
  };
}

export function findBackgroundWorkStopResolution(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  commandId: CommandId,
) {
  const resolved = activities.findLast((entry) => {
    if (entry.kind !== "provider.turn.interrupt.resolved") return false;
    const payload =
      typeof entry.payload === "object" && entry.payload !== null
        ? (entry.payload as Record<string, unknown>)
        : null;
    return payload?.requestId === commandId;
  });
  const payload =
    resolved && typeof resolved.payload === "object" && resolved.payload !== null
      ? (resolved.payload as Record<string, unknown>)
      : null;
  switch (payload?.outcome) {
    case "interrupted":
      return { outcome: payload.outcome, alert: null };
    case "work-changed":
      return {
        outcome: payload.outcome,
        alert: {
          title: "Work already changed",
          message: "A newer turn or provider session is active, so it was left running.",
        },
      };
    case "no-session":
      return {
        outcome: payload.outcome,
        alert: {
          title: "Stop status unknown",
          message:
            "No provider session was available when Stop was handled. Check the thread state.",
        },
      };
    case "interrupt-failed":
      return {
        outcome: payload.outcome,
        alert: {
          title: "Stop failed",
          message: "The provider could not interrupt the work. It may still be running.",
        },
      };
    default:
      return null;
  }
}
