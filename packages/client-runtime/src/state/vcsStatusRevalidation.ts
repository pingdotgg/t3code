import type { EnvironmentId } from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { type AtomCommand, type AtomCommandResult, runAtomCommand } from "./runtime.ts";

interface VcsStatusRevalidationTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}

/**
 * One atom per environment and cwd, shared by every subscriber, that refreshes
 * VCS status while mounted: on mount and on each reconnect, once `connected`
 * is true.
 */
export function createVcsStatusRevalidationAtomFamily<R>(input: {
  readonly refreshStatus: AtomCommand<
    { readonly environmentId: EnvironmentId; readonly input: { readonly cwd: string } },
    R,
    unknown
  >;
  readonly connected: (environmentId: EnvironmentId) => Atom.Atom<boolean>;
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

    return Atom.make((get) => {
      // Rebuilds only when the connection flag flips, so each reconnect refreshes once.
      if (get(input.connected(environmentId))) {
        void refresh(get.registry);
      }
    }).pipe(Atom.withLabel(`vcs-status-revalidation:${key}`));
  });
  const idle = Atom.make<void>(undefined).pipe(Atom.withLabel("vcs-status-revalidation:idle"));
  return (target: VcsStatusRevalidationTarget | null): Atom.Atom<void> =>
    target === null ? idle : family({ environmentId: target.environmentId, cwd: target.cwd });
}
