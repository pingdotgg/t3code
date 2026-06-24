import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

const EMPTY_ASYNC_RESULT_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("web-environment-query:empty"),
);

export interface EnvironmentQueryView<A> {
  readonly data: A | null;
  readonly error: string | null;
  /**
   * `true` whenever a request is in flight, including background refreshes that
   * still have cached data to show. Use this for non-blocking indicators (e.g.
   * disabling a "Refresh" button), NOT for gating whether content renders.
   */
  readonly isPending: boolean;
  /**
   * `true` only on the initial load, when there is no cached value to display
   * yet. Gate full-screen spinners on this — gating on {@link isPending} blanks
   * the view on every background poll (the regression that replaced React
   * Query's `isLoading` semantics).
   */
  readonly isLoading: boolean;
  readonly refresh: () => void;
}

function formatError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The environment request failed.";
}

export function useEnvironmentQuery<A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>> | null,
): EnvironmentQueryView<A> {
  const selectedAtom = atom ?? EMPTY_ASYNC_RESULT_ATOM;
  const result = useAtomValue(selectedAtom);
  const refresh = useAtomRefresh(selectedAtom);
  const value = AsyncResult.value(result);
  return {
    data: Option.getOrNull(value),
    error: result._tag === "Failure" ? formatError(result.cause) : null,
    isPending: atom !== null && result.waiting,
    isLoading: atom !== null && result.waiting && Option.isNone(value),
    refresh,
  };
}
