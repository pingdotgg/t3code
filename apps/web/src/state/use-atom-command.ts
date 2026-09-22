import { RegistryContext } from "@effect/atom-react";
import {
  type AtomCommand,
  type AtomCommandOptions,
  type AtomCommandResult,
  runAtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { Atom } from "effect/unstable/reactivity";
import { useCallback, useContext } from "react";

/**
 * Read an atom's current value at call time rather than at render. Writes that queue behind
 * each other must see what the earlier one committed, which a render-time snapshot cannot do.
 */
export function useAtomReader(): <A>(atom: Atom.Atom<A>) => A {
  const registry = useContext(RegistryContext);
  return useCallback((atom) => registry.get(atom), [registry]);
}

export function useAtomCommand<A, E, W>(
  command: AtomCommand<W, A, E>,
  options?: string | AtomCommandOptions,
): (value: W) => Promise<AtomCommandResult<A, E>> {
  const registry = useContext(RegistryContext);
  const label = typeof options === "string" ? options : (options?.label ?? command.label);
  const reportFailure = typeof options === "string" ? true : (options?.reportFailure ?? true);
  const reportDefect = typeof options === "string" ? true : (options?.reportDefect ?? true);

  return useCallback(
    (value: W) => runAtomCommand(registry, command, value, { label, reportFailure, reportDefect }),
    [command, label, registry, reportDefect, reportFailure],
  );
}
