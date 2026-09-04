import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  resolveThreadAwarenessPhase,
  type AgentAwarenessPhase,
  type ProjectThreadAwarenessInput,
} from "@t3tools/shared/agentAwareness";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "./rpc/atomRegistry";
import { environmentShell } from "./state/shell";
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

export interface ObservedThreadPhase {
  readonly phase: AgentAwarenessPhase;
  readonly armed: boolean;
}

export interface AgentTurnNotificationSource {
  readonly shells: ReadonlyArray<NotifiableThreadShell>;
  readonly liveEnvironmentIds: ReadonlySet<EnvironmentId>;
}

export interface AgentTurnCompletion {
  readonly threadKey: string;
  readonly threadTitle: string;
}

export function collectAgentTurnCompletions(
  previousPhases: ReadonlyMap<string, ObservedThreadPhase>,
  source: AgentTurnNotificationSource,
): {
  readonly completions: ReadonlyArray<AgentTurnCompletion>;
  readonly nextPhases: ReadonlyMap<string, ObservedThreadPhase>;
} {
  const completions: AgentTurnCompletion[] = [];
  const nextPhases = new Map<string, ObservedThreadPhase>();
  for (const shell of source.shells) {
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
    // Cached and resynchronizing snapshots can replay work that finished while
    // the app was closed, so only a phase observed on a live connection arms a
    // notification. Arming is sticky across active phases: a reconnect that
    // re-observes the same running thread keeps its completion notifiable.
    const armed =
      NOTIFYING_PREVIOUS_PHASES.has(phase) &&
      (source.liveEnvironmentIds.has(shell.environmentId) || previous?.armed === true);
    nextPhases.set(threadKey, { phase, armed });
    if (previous?.armed === true && phase === "completed") {
      completions.push({ threadKey, threadTitle: shell.title });
    }
  }
  return { completions, nextPhases };
}

function liveIdsEqual(
  left: ReadonlySet<EnvironmentId>,
  right: ReadonlySet<EnvironmentId>,
): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const environmentId of left) {
    if (!right.has(environmentId)) {
      return false;
    }
  }
  return true;
}

export function createAgentTurnNotificationSourceAtom(input: {
  readonly threadShellsAtom: Atom.Atom<ReadonlyArray<NotifiableThreadShell>>;
  readonly shellStateValueAtom: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellState>;
}) {
  // The shell state changes on every stream event, so depending on it directly
  // would rerun the collector for updates that change neither shells nor
  // liveness. The boolean projection keeps its value identity across those,
  // which stops the propagation there.
  const environmentLiveAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(input.shellStateValueAtom(environmentId)).status === "live").pipe(
      Atom.withLabel(`web-desktop-agent-turn-notification-live:${environmentId}`),
    ),
  );

  let previousSource: AgentTurnNotificationSource | null = null;
  return Atom.make((get): AgentTurnNotificationSource => {
    const shells = get(input.threadShellsAtom);
    const liveEnvironmentIds = new Set<EnvironmentId>();
    for (const shell of shells) {
      if (liveEnvironmentIds.has(shell.environmentId)) {
        continue;
      }
      if (get(environmentLiveAtom(shell.environmentId))) {
        liveEnvironmentIds.add(shell.environmentId);
      }
    }
    if (
      previousSource !== null &&
      previousSource.shells === shells &&
      liveIdsEqual(previousSource.liveEnvironmentIds, liveEnvironmentIds)
    ) {
      return previousSource;
    }
    previousSource = { shells, liveEnvironmentIds };
    return previousSource;
  }).pipe(Atom.withLabel("web-desktop-agent-turn-notification-source"));
}

const agentTurnNotificationSourceAtom = createAgentTurnNotificationSourceAtom({
  threadShellsAtom: environmentThreadShells.threadShellsAtom,
  shellStateValueAtom: environmentShell.stateValueAtom,
});

export function startDesktopAgentTurnNotifications(): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  const notify = window.desktopBridge?.notifyAgentTurnCompleted;
  if (notify === undefined) {
    return () => {};
  }
  // Baseline from the current source before subscribing: the subscription
  // fires only on change, so a thread already running at mount still
  // notifies when it completes.
  let phases: ReadonlyMap<string, ObservedThreadPhase> = collectAgentTurnCompletions(
    new Map(),
    appAtomRegistry.get(agentTurnNotificationSourceAtom),
  ).nextPhases;
  return appAtomRegistry.subscribe(agentTurnNotificationSourceAtom, (source) => {
    const { completions, nextPhases } = collectAgentTurnCompletions(phases, source);
    phases = nextPhases;
    for (const completion of completions) {
      notify({ threadTitle: completion.threadTitle }).catch(() => {});
    }
  });
}
