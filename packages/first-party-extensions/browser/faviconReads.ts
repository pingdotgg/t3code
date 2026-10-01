/**
 * The `getFavicon` read queue behind the Browser panel's captured tier. Views
 * request the refs their sessions carry; at most `maxInFlight` reads run at
 * once, and each finished read starts the next queued one, so demand never
 * waits for another session event. A ref is read once: a settled ref is not
 * read again even after the cache ages its result out, so a bounded cache can
 * never drive a re-read loop. Demand is kept per view: a ref stays queued,
 * and its read keeps running, while any view that asked for it is open. A
 * read cancelled because all of its views closed is not settled; a later
 * request (from any view) reads it again.
 */

/** Reads one ref: the image `data:` URL, or null when the server refused it. */
export type FaviconRead = (ref: string, signal: AbortSignal) => Promise<string | null>;

export type FaviconReadQueue = {
  /** Queue these refs for reading on behalf of the view that owns `signal`. */
  readonly request: (refs: readonly string[], read: FaviconRead, signal: AbortSignal) => void;
  readonly inFlight: () => number;
};

/** Settled refs remembered so they are never re-read; oldest forgotten past this. */
const SETTLED_REFS_MAX = 4096;

export function createFaviconReadQueue(options: {
  readonly maxInFlight: number;
  /** Records a read's result (null: refused or failed). */
  readonly settle: (ref: string, src: string | null) => void;
}): FaviconReadQueue {
  // Every view still wanting a ref (its signal, and the read it asked with),
  // in request order. A ref is dropped only when all of its views have closed.
  const queued = new Map<string, Map<AbortSignal, FaviconRead>>();
  // A running read, and how a newly requesting view joins it. It is aborted
  // only when every view that joined it has closed.
  const running = new Map<
    string,
    { readonly controller: AbortController; readonly join: (signal: AbortSignal) => void }
  >();
  const settled = new Set<string>();

  const finish = (ref: string, src: string | null) => {
    settled.add(ref);
    if (settled.size > SETTLED_REFS_MAX) settled.delete(settled.values().next().value!);
    options.settle(ref, src);
  };

  const start = (ref: string, views: Map<AbortSignal, FaviconRead>, read: FaviconRead) => {
    const controller = new AbortController();
    const joined = new Set<AbortSignal>();
    const release = () => {
      for (const signal of joined) if (!signal.aborted) return;
      controller.abort();
    };
    const join = (signal: AbortSignal) => {
      joined.add(signal);
      signal.addEventListener("abort", release, { once: true });
    };
    running.set(ref, { controller, join });
    for (const signal of views.keys()) join(signal);
    read(ref, controller.signal)
      .then(
        (src) => finish(ref, src),
        () => {
          if (!controller.signal.aborted) finish(ref, null);
        },
      )
      .finally(() => {
        for (const signal of joined) signal.removeEventListener("abort", release);
        running.delete(ref);
        pump();
      });
  };

  const pump = () => {
    for (const [ref, views] of queued) {
      if (running.size >= options.maxInFlight) return;
      for (const signal of views.keys()) if (signal.aborted) views.delete(signal);
      const read = views.values().next().value;
      if (read === undefined || settled.has(ref)) {
        queued.delete(ref);
        continue;
      }
      if (running.has(ref)) continue;
      queued.delete(ref);
      start(ref, views, read);
    }
  };

  return {
    request(refs, read, signal) {
      if (signal.aborted) return;
      for (const ref of refs) {
        if (settled.has(ref)) continue;
        const reading = running.get(ref);
        if (reading && !reading.controller.signal.aborted) reading.join(signal);
        else queued.set(ref, (queued.get(ref) ?? new Map()).set(signal, read));
      }
      pump();
    },
    inFlight: () => running.size,
  };
}
