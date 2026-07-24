import { RegistryContext } from "@effect/atom-react";
import {
  executeAtomQuery,
  type AtomCommandOptions,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, type Atom } from "effect/unstable/reactivity";
import { useCallback, useContext } from "react";

export function useAtomQueryRunner<T, A, E>(
  family: (target: T) => Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  options?: string | AtomCommandOptions,
): (target: T) => Promise<AtomCommandResult<A, E>> {
  const registry = useContext(RegistryContext);
  const explicitLabel = typeof options === "string" ? options : options?.label;
  const reportFailure = typeof options === "string" ? true : (options?.reportFailure ?? true);
  const reportDefect = typeof options === "string" ? true : (options?.reportDefect ?? true);
  const forceRefresh = typeof options === "string" ? false : (options?.forceRefresh ?? false);

  return useCallback(
    (target: T) => {
      const atom = family(target);
      return executeAtomQuery(registry, atom, {
        label: explicitLabel ?? atom.label?.[0] ?? "atom query",
        reportFailure,
        reportDefect,
        forceRefresh,
      });
    },
    [explicitLabel, family, forceRefresh, registry, reportDefect, reportFailure],
  );
}
