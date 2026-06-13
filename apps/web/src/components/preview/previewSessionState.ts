import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime";
import type { PreviewListResult, ScopedThreadRef } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { ensureEnvironmentApi } from "~/environmentApi";
import { appAtomRegistry } from "~/rpc/atomRegistry";

const PREVIEW_SESSION_STALE_TIME_MS = 5_000;
const PREVIEW_SESSION_IDLE_TTL_MS = 5 * 60_000;

class PreviewSessionQueryError extends Data.TaggedError("PreviewSessionQueryError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const previewSessionListAtom = Atom.family((threadKey: string) =>
  Atom.make(
    Effect.tryPromise({
      try: () => {
        const threadRef = parseScopedThreadKey(threadKey);
        if (!threadRef) {
          throw new Error(`Invalid scoped thread key: ${threadKey}`);
        }
        return ensureEnvironmentApi(threadRef.environmentId).preview.list({
          threadId: threadRef.threadId,
        });
      },
      catch: (cause) =>
        new PreviewSessionQueryError({
          message: "Could not load preview sessions.",
          cause,
        }),
    }),
  ).pipe(
    Atom.swr({
      staleTime: PREVIEW_SESSION_STALE_TIME_MS,
      revalidateOnMount: true,
    }),
    Atom.setIdleTTL(PREVIEW_SESSION_IDLE_TTL_MS),
    Atom.withLabel(`preview:sessions:${threadKey}`),
  ),
);

export interface PreviewSessionQueryState {
  readonly data: PreviewListResult | null;
  readonly error: string | null;
  readonly isPending: boolean;
}

export function refreshPreviewSessionState(threadRef: ScopedThreadRef): void {
  appAtomRegistry.refresh(previewSessionListAtom(scopedThreadKey(threadRef)));
}

export function usePreviewSessionState(threadRef: ScopedThreadRef): PreviewSessionQueryState {
  const result = useAtomValue(previewSessionListAtom(scopedThreadKey(threadRef)));
  let error: string | null = null;
  if (result._tag === "Failure") {
    const cause = Cause.squash(result.cause);
    error = cause instanceof Error ? cause.message : "Could not load preview sessions.";
  }
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error,
    isPending: result.waiting,
  };
}
