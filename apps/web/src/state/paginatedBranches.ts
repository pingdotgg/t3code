import type { VcsListRefsResult } from "@lathe/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

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
