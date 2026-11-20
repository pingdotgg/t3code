import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ReviewDiffPreviewInput,
  ReviewDiffPreviewSource,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef } from "react";

import { reviewEnvironment } from "../state/changes";

/** Runs `refresh` when `revision` changes, which is how edits made outside the app reach a list that is already showing. */
export function useRevisionRefresh(revision: string, refresh: () => void): void {
  const seen = useRef(revision);
  useEffect(() => {
    if (seen.current === revision) return;
    seen.current = revision;
    refresh();
  }, [revision, refresh]);
}

export type DiffPreview =
  | { readonly state: "loading" }
  | { readonly state: "failed"; readonly message: string }
  | {
      readonly state: "ready";
      /** The one source the request asked for, or null when the checkout is not a repository. */
      readonly source: ReviewDiffPreviewSource | null;
      readonly refresh: () => void;
    };

/**
 * One diff source of a checkout, read through T3's review query. The query is read again when
 * `revision` changes, which is how edits made outside the app reach a list that is already showing.
 */
export function useDiffPreview(
  environmentId: EnvironmentId,
  input: ReviewDiffPreviewInput,
  revision: string,
): DiffPreview {
  const atom = reviewEnvironment.diffPreview({ environmentId, input });
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  useRevisionRefresh(revision, refresh);
  const preview = AsyncResult.getOrElse(result, () => null);
  if (preview !== null) return { state: "ready", source: preview.sources[0] ?? null, refresh };
  if (result._tag === "Failure") {
    const error = Cause.squash(result.cause);
    return { state: "failed", message: error instanceof Error ? error.message : String(error) };
  }
  return { state: "loading" };
}
