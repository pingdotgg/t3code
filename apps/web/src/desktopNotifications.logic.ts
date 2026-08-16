import type {
  BackgroundPolicySnapshot,
  DesktopNotificationEvent,
  DesktopNotificationSettings,
  DesktopNotificationTarget,
} from "@t3tools/contracts";
import {
  notificationEventForAwarenessTransition,
  type AgentAwarenessState,
} from "@t3tools/shared/agentAwareness";

export interface ObservedAgentAwareness {
  readonly key: string;
  readonly target: DesktopNotificationTarget;
  readonly state: AgentAwarenessState | null;
}

export interface AgentNotificationReconciliationContext {
  readonly previouslyAuthoritativeEnvironmentIds: ReadonlySet<string>;
  readonly authoritativeEnvironmentIds: ReadonlySet<string>;
}

export type AgentNotificationTransition =
  | {
      readonly type: "dismiss";
      readonly target: DesktopNotificationTarget;
    }
  | {
      readonly type: "show";
      readonly event: DesktopNotificationEvent;
      readonly state: AgentAwarenessState;
    };

export function reconcileAgentNotificationStates(
  previous: ReadonlyMap<string, AgentAwarenessState | null> | null,
  observed: ReadonlyArray<ObservedAgentAwareness>,
  context?: AgentNotificationReconciliationContext,
): {
  readonly next: ReadonlyMap<string, AgentAwarenessState | null>;
  readonly transitions: ReadonlyArray<AgentNotificationTransition>;
} {
  const next = new Map(previous ?? []);
  const transitions: AgentNotificationTransition[] = [];
  const observedKeys = new Set<string>();

  for (const entry of observed) {
    observedKeys.add(entry.key);
    const hadPrevious = previous?.has(entry.key) === true;
    const priorState = hadPrevious ? (previous?.get(entry.key) ?? null) : null;
    next.set(entry.key, entry.state);

    // The first complete shell snapshot is a baseline, never a backlog to replay. The same rule
    // applies when one environment first becomes authoritative after being disconnected.
    const environmentWasAuthoritative =
      context?.previouslyAuthoritativeEnvironmentIds.has(entry.target.environmentId) ?? true;
    const priorEvent = notificationEventForAwarenessTransition(null, priorState);
    const phaseChanged = priorState !== null && priorState.phase !== entry.state?.phase;
    if (phaseChanged && priorEvent !== null) {
      transitions.push({ type: "dismiss", target: entry.target });

      // Reconnects still baseline new work, but an alert that was already live must continue to
      // represent a current approval or input request when the attention type changed offline.
      const priorWasAttention = priorEvent === "approval" || priorEvent === "input";
      if (!environmentWasAuthoritative && priorWasAttention && entry.state !== null) {
        const currentEvent = notificationEventForAwarenessTransition(null, entry.state);
        if (currentEvent === "approval" || currentEvent === "input") {
          transitions.push({ type: "show", event: currentEvent, state: entry.state });
        }
      }
    }

    if (previous === null || !environmentWasAuthoritative) {
      continue;
    }

    const event = notificationEventForAwarenessTransition(priorState, entry.state);
    if (event !== null && entry.state !== null) {
      transitions.push({ type: "show", event, state: entry.state });
    }
  }

  if (previous !== null && context !== undefined) {
    for (const [key, priorState] of previous) {
      if (observedKeys.has(key)) {
        continue;
      }
      if (priorState === null) {
        next.delete(key);
        continue;
      }
      if (!context.authoritativeEnvironmentIds.has(priorState.environmentId)) {
        continue;
      }
      if (notificationEventForAwarenessTransition(null, priorState) !== null) {
        transitions.push({
          type: "dismiss",
          target: {
            environmentId: priorState.environmentId,
            threadId: priorState.threadId,
          },
        });
      }
      next.delete(key);
    }
  }

  return { next, transitions };
}

export function desktopNotificationEventEnabled(
  settings: DesktopNotificationSettings,
  event: DesktopNotificationEvent,
): boolean {
  return settings.enabled && settings.events[event];
}

export function shouldSuppressDesktopNotification(windowFocused: boolean): boolean {
  return windowFocused;
}

export function shouldSuppressBrowserNotification(input: {
  readonly windowFocused: boolean;
  readonly policy: Pick<BackgroundPolicySnapshot, "leases"> | null;
}): boolean {
  if (input.windowFocused || input.policy === null) {
    return true;
  }
  return input.policy.leases.some(
    (lease) => lease.clientKind === "desktop-renderer" || lease.focused,
  );
}
