import { RegistryContext } from "@effect/atom-react";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { type AsyncResult, type Atom } from "effect/reactivity";
import { use, useEffect, useRef, useState } from "react";

export function usePullToRefresh<A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>> | null) {
  const registry = use(RegistryContext);
  const request = useRef<{ atom: NonNullable<typeof atom>; controller: AbortController } | null>(
    null,
  );
  const [refreshingAtom, setRefreshingAtom] = useState<typeof atom>(null);
  if (refreshingAtom !== null && refreshingAtom !== atom) setRefreshingAtom(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- aborts the in-flight refresh for an atom when the atom changes or the component unmounts
  useEffect(
    () => () => {
      if (request.current?.atom === atom) request.current.controller.abort();
    },
    [atom],
  );

  const onRefresh = (beforeRefresh?: (signal: AbortSignal) => Promise<unknown>) => {
    if (!atom || (request.current?.atom === atom && !request.current.controller.signal.aborted))
      return;
    request.current?.controller.abort();
    const controller = new AbortController();
    request.current = { atom, controller };
    setRefreshingAtom(atom);
    void Promise.resolve()
      .then(() => {
        if (!controller.signal.aborted) return beforeRefresh?.(controller.signal);
      })
      .catch(() => undefined)
      .then(() => {
        if (controller.signal.aborted) return;
        return executeAtomQuery(registry, atom, {
          refresh: true,
          signal: controller.signal,
          reportFailure: false,
          reportDefect: false,
        });
      })
      .finally(() => {
        if (controller.signal.aborted || request.current?.controller !== controller) return;
        request.current = null;
        setRefreshingAtom(null);
      });
  };

  return { refreshing: atom !== null && refreshingAtom === atom, onRefresh };
}
