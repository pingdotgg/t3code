import { constVoid } from "effect/Function";

const abandonOnAbort = <A>(promise: Promise<A>, signal: AbortSignal): Promise<A> =>
  new Promise<A>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });

/**
 * Runs a tab's captures one at a time. A capture given a signal gives up when
 * it aborts, waiting included, so one that never gets a frame cannot stall
 * every capture behind it. One that gives up while still waiting keeps its
 * place, so the capture ahead of it never overlaps the next.
 */
export class CaptureLock {
  private tail: Promise<void> = Promise.resolve();

  run<A>(operation: () => Promise<A>, signal?: AbortSignal): Promise<A> {
    const previous = this.tail;
    const run = previous.then(() => {
      signal?.throwIfAborted();
      return operation();
    });
    const result = signal ? abandonOnAbort(run, signal) : run;
    this.tail = Promise.all([previous, result.then(constVoid, constVoid)]).then(constVoid);
    return result;
  }
}
