import { RegistryContext, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useContext } from "react";

const EMPTY_ASYNC_RESULT_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("web-environment-query:empty"),
);

export interface EnvironmentQueryView<A, E = unknown> {
  readonly data: A | null;
  readonly dataUpdatedAt: number;
  readonly error: string | null;
  readonly failure: E | null;
  readonly isPending: boolean;
  readonly isSuccess: boolean;
  readonly refresh: () => void;
}

export function formatEnvironmentQueryError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The environment request failed.";
}

function queryUpdatedAt(result: AsyncResult.AsyncResult<unknown, unknown>): number {
  return result._tag === "Success"
    ? result.timestamp
    : result._tag === "Failure"
      ? (Option.getOrNull(result.previousSuccess)?.timestamp ?? 0)
      : 0;
}

export function useEnvironmentQuery<A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>> | null,
): EnvironmentQueryView<A, E> {
  const selectedAtom = atom ?? EMPTY_ASYNC_RESULT_ATOM;
  const result = useAtomValue(selectedAtom);
  const refresh = useAtomRefresh(selectedAtom);
  return {
    data: AsyncResult.getOrElse(result, () => null),
    dataUpdatedAt: queryUpdatedAt(result),
    error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
    failure:
      result._tag === "Failure" ? Option.getOrNull(Cause.findErrorOption(result.cause)) : null,
    isPending: atom !== null && result.waiting,
    isSuccess: result._tag === "Success",
    refresh,
  };
}

/** Keep select outside the component; a new function rebuilds the derived atom on every render. */
export function useEnvironmentQuerySelector<A, E, B>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>> | null,
  select: (result: AsyncResult.AsyncResult<A, E>) => B,
): B {
  return useAtomValue(atom ?? EMPTY_ASYNC_RESULT_ATOM, select);
}

type QueryResultAtom = Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>;
const queryIsNewerAtoms = new WeakMap<
  QueryResultAtom,
  WeakMap<QueryResultAtom, Atom.Atom<boolean>>
>();
function queryIsNewerAtom(query: QueryResultAtom, than: QueryResultAtom): Atom.Atom<boolean> {
  let byThan = queryIsNewerAtoms.get(query);
  if (byThan === undefined) {
    byThan = new WeakMap();
    queryIsNewerAtoms.set(query, byThan);
  }
  let atom = byThan.get(than);
  if (atom === undefined) {
    atom = Atom.make((get) => queryUpdatedAt(get(query)) >= queryUpdatedAt(get(than)));
    byThan.set(than, atom);
  }
  return atom;
}

export function useEnvironmentQueryIsNewer(
  query: QueryResultAtom | null,
  than: QueryResultAtom | null,
): boolean {
  return useAtomValue(
    queryIsNewerAtom(query ?? EMPTY_ASYNC_RESULT_ATOM, than ?? EMPTY_ASYNC_RESULT_ATOM),
  );
}

/** Returns refresh and call-time pending state without subscribing to it. */
export function useEnvironmentQueryRefresh<A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>> | null,
): { readonly refresh: () => void; readonly isPending: () => boolean } {
  const registry = useContext(RegistryContext);
  const selectedAtom = atom ?? EMPTY_ASYNC_RESULT_ATOM;
  const refresh = useAtomRefresh(selectedAtom);
  return { refresh, isPending: () => atom !== null && registry.get(selectedAtom).waiting };
}
