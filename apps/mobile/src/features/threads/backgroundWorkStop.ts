import type {
  CommandId,
  OrchestrationThread,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";
import type { InterruptThreadTurnInput } from "@t3tools/client-runtime/operations";
import { satisfiesSemverRange } from "@t3tools/shared/semver";
import * as Predicate from "effect/Predicate";

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
    run: async <InterruptResult>(
      commandId: CommandId,
      interrupt: (attempt: { readonly resolve: () => void }) => Promise<InterruptResult>,
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
  serverVersion: string | null | undefined,
): InterruptThreadTurnInput | null {
  if (serverVersion === undefined) {
    return null;
  }
  const supportsGuardedInterrupt =
    serverVersion !== null && satisfiesSemverRange(serverVersion, ">=0.0.33");
  if (supportsGuardedInterrupt && thread.session?.status === "starting") {
    return null;
  }
  const runningTurnId = thread.session?.status === "running" ? thread.session.activeTurnId : null;
  const input: InterruptThreadTurnInput = {
    threadId: thread.id,
    commandId,
  };
  if (runningTurnId !== null) {
    Object.assign(input, { turnId: runningTurnId });
  }
  if (supportsGuardedInterrupt) {
    Object.assign(input, { expectedTurnId: thread.session?.activeTurnId ?? null });
    if (thread.session !== null) {
      Object.assign(input, { expectedSessionUpdatedAt: thread.session.updatedAt });
    }
  }
  return input;
}

export function findBackgroundWorkStopResolution(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  commandId: CommandId,
) {
  const resolved = activities.findLast(
    (entry) =>
      entry.kind === "provider.turn.interrupt.resolved" &&
      Predicate.isObjectOrArray(entry.payload) &&
      Predicate.hasProperty(entry.payload, "requestId") &&
      entry.payload.requestId === commandId,
  );
  const outcome =
    resolved &&
    Predicate.isObjectOrArray(resolved.payload) &&
    Predicate.hasProperty(resolved.payload, "outcome")
      ? resolved.payload.outcome
      : null;
  switch (outcome) {
    case "interrupted":
      return { outcome, alert: null };
    case "work-changed":
      return {
        outcome,
        alert: {
          title: "Work already changed",
          message: "A newer turn or provider session is active, so it was left running.",
        },
      };
    case "no-session":
      return {
        outcome,
        alert: {
          title: "Stop status unknown",
          message:
            "No provider session was available when Stop was handled. Check the thread state.",
        },
      };
    case "interrupt-failed":
      return {
        outcome,
        alert: {
          title: "Stop failed",
          message: "The provider could not interrupt the work. It may still be running.",
        },
      };
    default:
      return null;
  }
}
