import { RegistryContext } from "@effect/atom-react";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { type AsyncResult, type Atom } from "effect/reactivity";
import { use, useCallback, useEffect, useRef, useState } from "react";

/** Only a user's pull owns the refresh indicator; query invalidation stays silent. */
export function usePullToRefresh<A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>> | null) {
  const registry = use(RegistryContext);
  const request = useRef<{ atom: NonNullable<typeof atom>; controller: AbortController } | null>(
    null,
  );
  const [refreshingAtom, setRefreshingAtom] = useState<typeof atom>(null);
  if (refreshingAtom !== null && refreshingAtom !== atom) setRefreshingAtom(null);
  useEffect(
    () => () => {
      if (request.current?.atom === atom) request.current.controller.abort();
    },
    [atom],
  );

  const onRefresh = useCallback(() => {
    if (!atom || (request.current?.atom === atom && !request.current.controller.signal.aborted))
      return;
    request.current?.controller.abort();
    const controller = new AbortController();
    request.current = { atom, controller };
    setRefreshingAtom(atom);
    void executeAtomQuery(registry, atom, {
      refresh: true,
      signal: controller.signal,
      reportFailure: false,
      reportDefect: false,
    }).finally(() => {
      if (controller.signal.aborted || request.current?.controller !== controller) return;
      request.current = null;
      setRefreshingAtom(null);
    });
  }, [atom, registry]);

  return { refreshing: atom !== null && refreshingAtom === atom, onRefresh };
}
