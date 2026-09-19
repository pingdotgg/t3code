import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect, useRef } from "react";

const EMPTY_ASYNC_RESULT_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("mobile-environment-query:empty"),
);

export interface EnvironmentQueryView<A> {
  readonly data: A | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

function formatError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The environment request failed.";
}

// A success the picker's own navigation prefetched moments before the atom
// mounts is fresh; only values that sat in the warm cache need revalidation.
const WARM_QUERY_FRESH_MS = 500;

/**
 * Revalidates an environment query that mounts onto a warm cached atom.
 *
 * Query atoms outlive their subscribers through an idle TTL, and the swr
 * wrapper only re-checks staleness when the atom node is rebuilt. A view that
 * remounts onto a warm node therefore renders the cached value and never
 * refetches, which freezes reads whose ground truth changes outside the app,
 * such as the filesystem browse listing. Refreshes once per atom when it
 * mounts holding a settled result: successes older than a short freshness
 * window (so navigation prefetches are not fetched twice) and failures always
 * (so a transient error does not stick for the whole TTL). Cold atoms are
 * left to their own initial fetch.
 */
export function useWarmEnvironmentQueryRevalidation<A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>> | null,
): void {
  const result = useAtomValue(atom ?? EMPTY_ASYNC_RESULT_ATOM);
  const refresh = useAtomRefresh(atom ?? EMPTY_ASYNC_RESULT_ATOM);
  const revalidatedAtom = useRef<Atom.Atom<AsyncResult.AsyncResult<A, E>> | null>(null);
  useEffect(() => {
    if (atom === null || revalidatedAtom.current === atom) {
      return;
    }
    revalidatedAtom.current = atom;
    if (result.waiting || result._tag === "Initial") {
      return;
    }
    if (result._tag === "Success" && Date.now() - result.timestamp < WARM_QUERY_FRESH_MS) {
      return;
    }
    refresh();
  }, [atom, refresh, result]);
}

export function useEnvironmentQuery<A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>> | null,
): EnvironmentQueryView<A> {
  const selectedAtom = atom ?? EMPTY_ASYNC_RESULT_ATOM;
  const result = useAtomValue(selectedAtom);
  const refresh = useAtomRefresh(selectedAtom);
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: result._tag === "Failure" ? formatError(result.cause) : null,
    isPending: atom !== null && result.waiting,
    refresh,
  };
}
