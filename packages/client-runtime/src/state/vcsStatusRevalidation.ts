// @effect-diagnostics globalTimers:off - The wake debounce runs in an atom subscription, outside an Effect runtime.
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { type AtomCommand, type AtomCommandResult, runAtomCommand } from "./runtime.ts";

interface VcsStatusRevalidationTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}

/**
 * One atom per environment and cwd that refreshes VCS status while mounted and
 * shared by every subscriber. Refreshes only when `connected` is given and true
 * (on mount and on each reconnect), and on `subscribeWake` (debounced); the wake
 * subscription and timer end with the last subscriber.
 */
export function createVcsStatusRevalidationAtomFamily<R>(input: {
  readonly refreshStatus: AtomCommand<
    { readonly environmentId: EnvironmentId; readonly input: { readonly cwd: string } },
    R,
    unknown
  >;
  readonly connected?: (environmentId: EnvironmentId) => Atom.Atom<boolean>;
  readonly subscribeWake?: (wake: () => void) => () => void;
  readonly wakeDebounceMs?: number;
  readonly onRefreshed?: (result: AtomCommandResult<R, unknown>) => void;
}) {
  const family = Atom.family((target: VcsStatusRevalidationTarget) => {
    const { environmentId, cwd } = target;
    const key = `${environmentId}:${cwd}`;

    const refresh = async (registry: AtomRegistry.AtomRegistry) => {
      const result = await runAtomCommand(
        registry,
        input.refreshStatus,
        { environmentId, input: { cwd } },
        { reportFailure: false },
      );
      input.onRefreshed?.(result);
    };

    const wakeAtom = Atom.make((get) => {
      const subscribeWake = input.subscribeWake;
      if (subscribeWake === undefined) return;
      const registry = get.registry;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const unsubscribe = subscribeWake(() => {
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = undefined;
          void refresh(registry);
        }, input.wakeDebounceMs ?? 0);
      });
      get.addFinalizer(() => {
        if (timer !== undefined) clearTimeout(timer);
        unsubscribe();
      });
    }).pipe(Atom.withLabel(`vcs-status-revalidation:wake:${key}`));

    return Atom.make((get) => {
      get(wakeAtom);
      const connected = input.connected;
      // Rebuilds only when the connection flag flips, so each reconnect refreshes once.
      if (connected !== undefined && get(connected(environmentId))) {
        void refresh(get.registry);
      }
    }).pipe(Atom.withLabel(`vcs-status-revalidation:${key}`));
  });
  const idle = Atom.make<void>(undefined).pipe(Atom.withLabel("vcs-status-revalidation:idle"));
  return (target: VcsStatusRevalidationTarget | null): Atom.Atom<void> =>
    target === null ? idle : family({ environmentId: target.environmentId, cwd: target.cwd });
}
