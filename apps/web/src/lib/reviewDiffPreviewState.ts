import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ReviewDiffPreviewResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { readEnvironmentApi } from "../environmentApi";
import { appAtomRegistry } from "../rpc/atomRegistry";

const REVIEW_DIFF_PREVIEW_STALE_TIME_MS = 5_000;
const REVIEW_DIFF_PREVIEW_IDLE_TTL_MS = 5 * 60_000;
const REVIEW_DIFF_PREVIEW_KEY_SEPARATOR = "\u001f";

export interface ReviewDiffPreviewState {
  readonly data: ReviewDiffPreviewResult | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

function makeReviewDiffPreviewKey(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly baseRef: string | null;
}): string {
  return [input.environmentId, input.cwd, input.baseRef ?? ""].join(
    REVIEW_DIFF_PREVIEW_KEY_SEPARATOR,
  );
}

function parseReviewDiffPreviewKey(key: string): {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly baseRef: string | null;
} {
  const [environmentId, cwd = "", baseRef = ""] = key.split(REVIEW_DIFF_PREVIEW_KEY_SEPARATOR);
  return {
    environmentId: environmentId as EnvironmentId,
    cwd,
    baseRef: baseRef.length > 0 ? baseRef : null,
  };
}

const reviewDiffPreviewAtom = Atom.family((key: string) =>
  Atom.make(
    Effect.promise(async (): Promise<ReviewDiffPreviewResult> => {
      const target = parseReviewDiffPreviewKey(key);
      const api = readEnvironmentApi(target.environmentId);
      if (!api) {
        throw new Error("Remote connection is not ready.");
      }
      return api.review.getDiffPreview({
        cwd: target.cwd,
        ...(target.baseRef ? { baseRef: target.baseRef } : {}),
      });
    }),
  ).pipe(
    Atom.swr({
      staleTime: REVIEW_DIFF_PREVIEW_STALE_TIME_MS,
      revalidateOnMount: true,
    }),
    Atom.setIdleTTL(REVIEW_DIFF_PREVIEW_IDLE_TTL_MS),
    Atom.withLabel(`web:review:diff-preview:${key}`),
  ),
);

const EMPTY_REVIEW_DIFF_PREVIEW_RESULT_ATOM = Atom.make(
  AsyncResult.initial<ReviewDiffPreviewResult, never>(false),
).pipe(Atom.keepAlive, Atom.withLabel("web:review:diff-preview:null"));

function readReviewDiffPreviewError(
  result: AsyncResult.AsyncResult<ReviewDiffPreviewResult, unknown>,
): string | null {
  if (result._tag !== "Failure") {
    return null;
  }

  const error = Cause.squash(result.cause);
  return error instanceof Error ? error.message : "Failed to load review diffs.";
}

export function useReviewDiffPreview(
  input: {
    readonly environmentId: EnvironmentId | null;
    readonly cwd: string | null;
    readonly baseRef?: string | null;
  },
  options: { readonly enabled?: boolean } = {},
): ReviewDiffPreviewState {
  const enabled = options.enabled ?? true;
  const baseRef = input.baseRef ?? null;
  const key = useMemo(() => {
    if (!enabled || !input.environmentId || !input.cwd) {
      return null;
    }
    return makeReviewDiffPreviewKey({
      environmentId: input.environmentId,
      cwd: input.cwd,
      baseRef,
    });
  }, [baseRef, enabled, input.cwd, input.environmentId]);

  const atom = key ? reviewDiffPreviewAtom(key) : null;
  const result = useAtomValue(atom ?? EMPTY_REVIEW_DIFF_PREVIEW_RESULT_ATOM);
  const refresh = useCallback(() => {
    if (atom) {
      appAtomRegistry.refresh(atom);
    }
  }, [atom]);

  if (!atom) {
    return {
      data: null,
      error: null,
      isPending: false,
      refresh,
    };
  }

  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: readReviewDiffPreviewError(result),
    isPending: result.waiting,
    refresh,
  };
}
