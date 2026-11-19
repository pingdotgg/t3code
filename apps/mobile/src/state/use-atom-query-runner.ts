import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
  observeAtomQuery,
  type AtomQueryOptions,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { RegistryContext } from "@effect/atom-react";

import { AsyncResult, type Atom } from "effect/reactivity";
import { useContext } from "react";

export function useAtomQueryRunner<T, A, E>(
  family: (target: T) => Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  options?: string | Omit<AtomQueryOptions, "signal">,
): (target: T, call?: Pick<AtomQueryOptions, "signal">) => Promise<AtomCommandResult<A, E>> {
  const registry = useContext(RegistryContext);
  const explicitLabel = typeof options === "string" ? options : options?.label;
  const reportFailure = typeof options === "string" ? true : (options?.reportFailure ?? true);
  const reportDefect = typeof options === "string" ? true : (options?.reportDefect ?? true);
  const refresh = typeof options === "string" ? false : (options?.refresh ?? false);

  return (target, call) => {
    const atom = family(target);
    return Effect.runPromiseExit(
      observeAtomQuery(registry, atom, {
        label: explicitLabel ?? atom.label?.[0] ?? "atom query",
        reportFailure,
        reportDefect,
        refresh,
        ...call,
      }),
      { signal: call?.signal },
    ).then((exit) => (Exit.isSuccess(exit) ? exit.value : AsyncResult.failure(exit.cause)));
  };
}
