import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, type Atom } from "effect/unstable/reactivity";

export interface PostHogQueryError {
  readonly tag: "not-configured" | "unauthorized" | "other";
  readonly message: string;
}

export interface PostHogQueryView<A> {
  readonly data: A | null;
  readonly error: PostHogQueryError | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

function classifyFailure(cause: Cause.Cause<unknown>): PostHogQueryError {
  const error = Cause.squash(cause);
  const tag =
    typeof error === "object" && error !== null && "_tag" in error
      ? String((error as { readonly _tag: unknown })._tag)
      : "";
  const message =
    error instanceof Error && error.message.trim().length > 0
      ? error.message
      : "The PostHog request failed.";
  if (tag === "PostHogNotConfiguredError") return { tag: "not-configured", message };
  if (tag === "PostHogUnauthorizedError") return { tag: "unauthorized", message };
  return { tag: "other", message };
}

/** Like `useEnvironmentQuery`, but keeps the PostHog error kind so the page can branch on it. */
export function usePostHogQuery<A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
): PostHogQueryView<A> {
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: result._tag === "Failure" ? classifyFailure(result.cause) : null,
    isPending: result.waiting,
    refresh,
  };
}
