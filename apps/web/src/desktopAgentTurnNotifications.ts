import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  resolveThreadAwarenessPhase,
  type AgentAwarenessPhase,
  type ProjectThreadAwarenessInput,
} from "@t3tools/shared/agentAwareness";

import { appAtomRegistry } from "./rpc/atomRegistry";
import { environmentThreadShells } from "./state/threads";

export type NotifiableThreadShell = ProjectThreadAwarenessInput["thread"] & {
  readonly environmentId: EnvironmentId;
};

// A booting session projects a transient completed ("ready" before the first
// turn, the same phantom AgentAwarenessRelay defers), so "starting" never
// arms a notification; the real completion still fires off the later running
// edge.
const NOTIFYING_PREVIOUS_PHASES: ReadonlySet<AgentAwarenessPhase> = new Set([
  "running",
  "waiting_for_approval",
  "waiting_for_input",
]);

export interface AgentTurnCompletion {
  readonly threadKey: string;
  readonly threadTitle: string;
}

export function collectAgentTurnCompletions(
  previousPhases: ReadonlyMap<string, AgentAwarenessPhase>,
  shells: ReadonlyArray<NotifiableThreadShell>,
): {
  readonly completions: ReadonlyArray<AgentTurnCompletion>;
  readonly nextPhases: ReadonlyMap<string, AgentAwarenessPhase>;
} {
  const completions: AgentTurnCompletion[] = [];
  const nextPhases = new Map<string, AgentAwarenessPhase>();
  for (const shell of shells) {
    const threadKey = scopedThreadKey({ environmentId: shell.environmentId, threadId: shell.id });
    const previous = previousPhases.get(threadKey);
    const phase = resolveThreadAwarenessPhase(shell);
    if (phase === null) {
      // The projector emits transient nulls mid-write (see the confirmation
      // deferral in AgentAwarenessRelay), so a null must not break a
      // running-to-completed chain; the previous recorded phase carries over.
      if (previous !== undefined) {
        nextPhases.set(threadKey, previous);
      }
      continue;
    }
    nextPhases.set(threadKey, phase);
    if (
      previous !== undefined &&
      NOTIFYING_PREVIOUS_PHASES.has(previous) &&
      phase === "completed"
    ) {
      completions.push({ threadKey, threadTitle: shell.title });
    }
  }
  return { completions, nextPhases };
}

export function startDesktopAgentTurnNotifications(): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  const notify = window.desktopBridge?.notifyAgentTurnCompleted;
  if (notify === undefined) {
    return () => {};
  }
  // Baseline from the current shells before subscribing: the subscription
  // fires only on change, so a thread already running at mount still
  // notifies when it completes.
  let phases: ReadonlyMap<string, AgentAwarenessPhase> = collectAgentTurnCompletions(
    new Map(),
    appAtomRegistry.get(environmentThreadShells.threadShellsAtom),
  ).nextPhases;
  return appAtomRegistry.subscribe(environmentThreadShells.threadShellsAtom, (shells) => {
    const { completions, nextPhases } = collectAgentTurnCompletions(phases, shells);
    phases = nextPhases;
    for (const completion of completions) {
      notify({ threadTitle: completion.threadTitle }).catch(() => {});
    }
  });
}
