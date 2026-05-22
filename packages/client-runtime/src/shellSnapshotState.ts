import type {
  EnvironmentId,
  OrchestrationShellSnapshot,
  OrchestrationShellStreamEvent,
} from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

import { applyShellStreamEvent } from "./shellSnapshotReducer.ts";

export interface ShellSnapshotState {
  readonly data: OrchestrationShellSnapshot | null;
  readonly error: string | null;
  readonly isPending: boolean;
}

export interface ShellSnapshotTarget {
  readonly environmentId: EnvironmentId | null;
}

export const EMPTY_SHELL_SNAPSHOT_STATE = Object.freeze<ShellSnapshotState>({
  data: null,
  error: null,
  isPending: false,
});

const INITIAL_SHELL_SNAPSHOT_STATE = Object.freeze<ShellSnapshotState>({
  data: null,
  error: null,
  isPending: true,
});

const knownShellSnapshotKeys = new Set<string>();

export const shellSnapshotStateAtom = Atom.family((key: string) => {
  knownShellSnapshotKeys.add(key);
  return Atom.make(INITIAL_SHELL_SNAPSHOT_STATE).pipe(
    Atom.keepAlive,
    Atom.withLabel(`shell-snapshot:${key}`),
  );
});

export const EMPTY_SHELL_SNAPSHOT_ATOM = Atom.make(EMPTY_SHELL_SNAPSHOT_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("shell-snapshot:null"),
);

export function getShellSnapshotTargetKey(target: ShellSnapshotTarget): string | null {
  return target.environmentId;
}

export interface ShellSnapshotManagerConfig {
  readonly getRegistry: () => AtomRegistry.AtomRegistry;
}

export function createShellSnapshotManager(config: ShellSnapshotManagerConfig) {
  function getSnapshot(target: ShellSnapshotTarget): ShellSnapshotState {
    const targetKey = getShellSnapshotTargetKey(target);
    if (targetKey === null) {
      return EMPTY_SHELL_SNAPSHOT_STATE;
    }

    return config.getRegistry().get(shellSnapshotStateAtom(targetKey));
  }

  function setState(targetKey: string, nextState: ShellSnapshotState): void {
    config.getRegistry().set(shellSnapshotStateAtom(targetKey), nextState);
  }

  function markPending(target: ShellSnapshotTarget): void {
    const targetKey = getShellSnapshotTargetKey(target);
    if (targetKey === null) {
      return;
    }

    const current = config.getRegistry().get(shellSnapshotStateAtom(targetKey));
    setState(targetKey, {
      data: current.data,
      error: null,
      isPending: true,
    });
  }

  function syncSnapshot(target: ShellSnapshotTarget, snapshot: OrchestrationShellSnapshot): void {
    const targetKey = getShellSnapshotTargetKey(target);
    if (targetKey === null) {
      return;
    }

    setState(targetKey, {
      data: snapshot,
      error: null,
      isPending: false,
    });
  }

  function applyEvent(target: ShellSnapshotTarget, event: OrchestrationShellStreamEvent): void {
    const targetKey = getShellSnapshotTargetKey(target);
    if (targetKey === null) {
      return;
    }

    const current = config.getRegistry().get(shellSnapshotStateAtom(targetKey));
    if (current.data === null) {
      return;
    }

    setState(targetKey, {
      data: applyShellStreamEvent(current.data, event),
      error: null,
      isPending: false,
    });
  }

  function invalidate(target?: ShellSnapshotTarget): void {
    if (target) {
      const targetKey = getShellSnapshotTargetKey(target);
      if (targetKey !== null) {
        setState(targetKey, EMPTY_SHELL_SNAPSHOT_STATE);
      }
      return;
    }

    for (const key of knownShellSnapshotKeys) {
      setState(key, EMPTY_SHELL_SNAPSHOT_STATE);
    }
  }

  function reset(): void {
    invalidate();
  }

  return {
    markPending,
    syncSnapshot,
    applyEvent,
    getSnapshot,
    invalidate,
    reset,
  };
}
