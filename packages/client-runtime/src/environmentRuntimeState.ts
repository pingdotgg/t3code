import type { EnvironmentId, ServerConfig as T3ServerConfig } from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

export type EnvironmentConnectionState =
  | "idle"
  | "connecting"
  | "ready"
  | "reconnecting"
  | "disconnected";

export interface EnvironmentRuntimeState {
  readonly connectionState: EnvironmentConnectionState;
  readonly connectionError: string | null;
  readonly serverConfig: T3ServerConfig | null;
}

export interface EnvironmentRuntimeTarget {
  readonly environmentId: EnvironmentId | null;
}

export const EMPTY_ENVIRONMENT_RUNTIME_STATE = Object.freeze<EnvironmentRuntimeState>({
  connectionState: "idle",
  connectionError: null,
  serverConfig: null,
});

const knownEnvironmentRuntimeKeys = new Set<string>();

export const environmentRuntimeStateAtom = Atom.family((key: string) => {
  knownEnvironmentRuntimeKeys.add(key);
  return Atom.make(EMPTY_ENVIRONMENT_RUNTIME_STATE).pipe(
    Atom.keepAlive,
    Atom.withLabel(`environment-runtime:${key}`),
  );
});

export const EMPTY_ENVIRONMENT_RUNTIME_ATOM = Atom.make(EMPTY_ENVIRONMENT_RUNTIME_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("environment-runtime:null"),
);

export function getEnvironmentRuntimeTargetKey(target: EnvironmentRuntimeTarget): string | null {
  return target.environmentId;
}

export interface EnvironmentRuntimeManagerConfig {
  readonly getRegistry: () => AtomRegistry.AtomRegistry;
}

export function createEnvironmentRuntimeManager(config: EnvironmentRuntimeManagerConfig) {
  function getSnapshot(target: EnvironmentRuntimeTarget): EnvironmentRuntimeState {
    const targetKey = getEnvironmentRuntimeTargetKey(target);
    if (targetKey === null) {
      return EMPTY_ENVIRONMENT_RUNTIME_STATE;
    }

    return config.getRegistry().get(environmentRuntimeStateAtom(targetKey));
  }

  function setState(target: EnvironmentRuntimeTarget, nextState: EnvironmentRuntimeState): void {
    const targetKey = getEnvironmentRuntimeTargetKey(target);
    if (targetKey === null) {
      return;
    }

    config.getRegistry().set(environmentRuntimeStateAtom(targetKey), nextState);
  }

  function patch(
    target: EnvironmentRuntimeTarget,
    updater: (current: EnvironmentRuntimeState) => EnvironmentRuntimeState,
  ): void {
    const targetKey = getEnvironmentRuntimeTargetKey(target);
    if (targetKey === null) {
      return;
    }

    const current = config.getRegistry().get(environmentRuntimeStateAtom(targetKey));
    config.getRegistry().set(environmentRuntimeStateAtom(targetKey), updater(current));
  }

  function invalidate(target?: EnvironmentRuntimeTarget): void {
    if (target) {
      setState(target, EMPTY_ENVIRONMENT_RUNTIME_STATE);
      return;
    }

    for (const key of knownEnvironmentRuntimeKeys) {
      config.getRegistry().set(environmentRuntimeStateAtom(key), EMPTY_ENVIRONMENT_RUNTIME_STATE);
    }
  }

  function reset(): void {
    invalidate();
  }

  return {
    getSnapshot,
    setState,
    patch,
    invalidate,
    reset,
  };
}
