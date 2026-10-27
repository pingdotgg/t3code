import * as Option from "effect/Option";
import { AsyncResult, type Atom, type AtomRegistry } from "effect/reactivity";

/**
 * Resolves with the first defined `settle` result for a query atom's value.
 * Resolves `undefined` once `signal` aborts or the query fails, because a
 * failed query can no longer report the state the caller is waiting for.
 * Subscribing keeps the atom mounted, so the subscription ends on every exit.
 */
export function waitForQuerySettled<A, E, R>(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>;
  readonly settle: (value: A | null) => R | undefined;
  readonly signal: AbortSignal;
}): Promise<R | undefined> {
  const { registry, atom, settle, signal } = input;
  return new Promise((resolve) => {
    let done = false;
    let unsubscribe: (() => void) | undefined;
    const finish = (result: R | undefined) => {
      if (done) return;
      done = true;
      unsubscribe?.();
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => finish(undefined);
    const check = (result: AsyncResult.AsyncResult<A, E>) => {
      if (AsyncResult.isFailure(result)) return finish(undefined);
      const settled = settle(Option.getOrNull(AsyncResult.value(result)));
      if (settled !== undefined) finish(settled);
    };
    if (signal.aborted) return finish(undefined);
    signal.addEventListener("abort", onAbort);
    unsubscribe = registry.subscribe(atom, check, { immediate: true });
    if (done) unsubscribe();
  });
}
