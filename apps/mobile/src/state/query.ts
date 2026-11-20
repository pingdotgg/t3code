import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { msg, useMessages } from "gt-react-native";

import { m, type MessageResolver } from "../i18n/messages";

const EMPTY_ASYNC_RESULT_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("mobile-environment-query:empty"),
);

export interface EnvironmentQueryView<A> {
  readonly data: A | null;
  readonly successResult: AsyncResult.Success<A, unknown> | null;
  readonly error: string | null;
  readonly failure: unknown;
  readonly isPending: boolean;
  readonly isSuccess: boolean;
  readonly refresh: () => void;
}

/** What a request cut off by a dropped connection says; it carries no error of its own. */
export const ENVIRONMENT_REQUEST_INTERRUPTED = msg("The connection dropped before this finished.");

export function formatEnvironmentQueryError(
  cause: Cause.Cause<unknown>,
  resolve: MessageResolver = m,
): string {
  if (Cause.hasInterruptsOnly(cause)) return resolve(ENVIRONMENT_REQUEST_INTERRUPTED);
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : resolve(msg("The environment request failed."));
}

export function useEnvironmentQuery<A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>> | null,
): EnvironmentQueryView<A> {
  const selectedAtom = atom ?? EMPTY_ASYNC_RESULT_ATOM;
  const result = useAtomValue(selectedAtom);
  const refresh = useAtomRefresh(selectedAtom);
  const resolve = useMessages();
  return {
    data: AsyncResult.getOrElse(result, () => null),
    // Data may be structurally shared; only a settled success proves a new response.
    successResult: result._tag === "Success" && !result.waiting ? result : null,
    failure: result._tag === "Failure" ? Cause.squash(result.cause) : null,
    error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause, resolve) : null,
    isPending: atom !== null && result.waiting,
    isSuccess: result._tag === "Success",
    refresh,
  };
}
