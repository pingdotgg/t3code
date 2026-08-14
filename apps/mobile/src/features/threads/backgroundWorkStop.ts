import type {
  CommandId,
  OrchestrationThread,
  OrchestrationThreadActivity,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { satisfiesSemverRange } from "@t3tools/shared/semver";

export interface BackgroundWorkStopConfirmation {
  readonly title: string;
  readonly message: string;
  readonly actions: ReadonlyArray<{
    readonly text: string;
    readonly style?: "cancel" | "destructive";
    readonly onPress?: () => void;
  }>;
}

export interface BackgroundWorkStopOutcome {
  readonly title: string;
  readonly message: string;
}

export interface BackgroundWorkStopGuardOptions {
  readonly timeoutMs?: number;
  readonly onTimeout?: (outcome: BackgroundWorkStopOutcome) => void;
}

export interface BackgroundWorkStopGuard {
  readonly isInFlight: () => boolean;
  readonly resolve: () => void;
  readonly run: (interrupt: () => Promise<unknown>) => Promise<boolean>;
}

export function createBackgroundWorkStopGuard(
  onInFlightChange: (inFlight: boolean) => void,
  options?: BackgroundWorkStopGuardOptions,
): BackgroundWorkStopGuard {
  let inFlight = false;
  let generation = 0;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const resolve = () => {
    if (timeout !== null) {
      clearTimeout(timeout);
      timeout = null;
    }
    if (!inFlight) {
      return;
    }
    inFlight = false;
    onInFlightChange(false);
  };
  return {
    isInFlight: () => inFlight,
    resolve,
    run: async (interrupt) => {
      if (inFlight) {
        return false;
      }
      const runGeneration = ++generation;
      inFlight = true;
      onInFlightChange(true);
      timeout = setTimeout(() => {
        timeout = null;
        if (!inFlight || generation !== runGeneration) {
          return;
        }
        inFlight = false;
        onInFlightChange(false);
        options?.onTimeout?.({
          title: "Stop status unknown",
          message:
            "This server did not confirm whether background work stopped. Check the thread before trying again.",
        });
      }, options?.timeoutMs ?? 5_000);
      try {
        await interrupt();
        return true;
      } catch (error) {
        if (generation === runGeneration) {
          resolve();
        }
        throw error;
      }
    },
  };
}

export function backgroundWorkStopConfirmation(
  onConfirm: () => void,
): BackgroundWorkStopConfirmation {
  return {
    title: "Stop background work?",
    message: "This interrupts any active turn and its background agents.",
    actions: [
      { text: "Cancel", style: "cancel" },
      { text: "Stop", style: "destructive", onPress: onConfirm },
    ],
  };
}

export function buildBackgroundWorkInterruptInput(
  thread: Pick<OrchestrationThread, "id" | "session">,
  commandId?: CommandId,
  serverVersion: string | null = null,
): {
  readonly threadId: ThreadId;
  readonly commandId?: CommandId;
  readonly turnId?: TurnId;
  readonly expectedTurnId?: TurnId | null;
  readonly expectedSessionUpdatedAt?: string;
} {
  const runningTurnId = thread.session?.status === "running" ? thread.session.activeTurnId : null;
  const supportsGuardedInterrupt =
    serverVersion !== null && satisfiesSemverRange(serverVersion, ">=0.0.33");
  return {
    threadId: thread.id,
    ...(commandId !== undefined ? { commandId } : {}),
    ...(runningTurnId !== null ? { turnId: runningTurnId } : {}),
    ...(supportsGuardedInterrupt && thread.session !== null
      ? {
          expectedTurnId: thread.session.activeTurnId,
          expectedSessionUpdatedAt: thread.session.updatedAt,
        }
      : {}),
  };
}

export interface BackgroundWorkStopResolution {
  readonly outcome: "interrupted" | "work-changed" | "no-session" | "interrupt-failed";
  readonly alert: BackgroundWorkStopOutcome | null;
}

export function findBackgroundWorkStopResolution(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  commandId: CommandId,
): BackgroundWorkStopResolution | null {
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
  const outcome = payload?.outcome;
  if (
    outcome !== "interrupted" &&
    outcome !== "work-changed" &&
    outcome !== "no-session" &&
    outcome !== "interrupt-failed"
  ) {
    return null;
  }

  const alert =
    outcome === "work-changed"
      ? {
          title: "Work already changed",
          message: "A newer turn or provider session is active, so it was left running.",
        }
      : outcome === "no-session"
        ? {
            title: "Stop status unknown",
            message:
              "No provider session was available when Stop was handled. Check the thread state.",
          }
        : outcome === "interrupt-failed"
          ? {
              title: "Stop failed",
              message: "The provider could not interrupt the work. It may still be running.",
            }
          : null;
  return { outcome, alert };
}
