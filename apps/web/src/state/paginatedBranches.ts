import type { VcsListRefsResult } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";

const DEFAULT_NEXT_PAGE_DISTANCE_PX = 96;

export function isPaginatedBranchesNextPagePending<E>(
  results: ReadonlyArray<AsyncResult.AsyncResult<VcsListRefsResult, E>>,
): boolean {
  const lastResult = results.at(-1);
  return (
    results.length > 1 &&
    lastResult?.waiting === true &&
    Option.isNone(AsyncResult.value(lastResult))
  );
}

export function shouldLoadNextBranchPageAfterScroll({
  previousScrollTop,
  scrollTop,
  scrollHeight,
  clientHeight,
  distanceThreshold = DEFAULT_NEXT_PAGE_DISTANCE_PX,
}: {
  previousScrollTop: number | null;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  distanceThreshold?: number;
}): boolean {
  if (previousScrollTop === null || scrollTop <= previousScrollTop) {
    return false;
  }

  return scrollHeight - scrollTop - clientHeight <= distanceThreshold;
}
