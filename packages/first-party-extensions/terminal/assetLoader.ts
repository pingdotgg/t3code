/**
 * Package-asset loading shared by every mounted placement of the surface.
 *
 * The runtime caps concurrent asset reads per installation at 4. Loading per
 * mount multiplied the reads by placements (side panel + dock) and StrictMode
 * effect replays, and an aborted read keeps its slot until the server
 * finishes it, so a cold load crossed the cap and the view fell back to plain
 * text. One shared load reads each asset once, in sequence. A read the cap
 * refuses is contention from another client of the same installation, so it
 * backs off and retries instead of failing the view.
 */

export type ReadAsset = (
  path: string,
  signal: AbortSignal,
) => Promise<{ readonly bytes: Uint8Array; readonly mediaType: string; readonly sha256: string }>;

/** Backoff before each retry of a read the runtime refused at its cap. */
export const ASSET_READ_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1_000, 2_000];

/** Matches both the per-installation and the global runtime read cap. */
export function isAssetReadLimitError(error: unknown): boolean {
  return error instanceof Error && /asset read limit reached/i.test(error.message);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One asset read, retried with backoff only while the runtime's cap refuses it. */
export async function readAssetWithRetry(
  read: ReadAsset,
  path: string,
  signal: AbortSignal,
  delays: readonly number[] = ASSET_READ_RETRY_DELAYS_MS,
  wait: (ms: number) => Promise<void> = sleep,
): ReturnType<ReadAsset> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read(path, signal);
    } catch (error) {
      const delay = delays[attempt];
      if (delay === undefined || signal.aborted || !isAssetReadLimitError(error)) throw error;
      await wait(delay);
      // A cancel during the backoff must not issue one more read.
      if (signal.aborted) throw error;
    }
  }
}

/**
 * Memoizes `load` per key while it is pending or succeeded. Callers share one
 * in-flight load, and a failure is forgotten so the next mount tries again.
 */
export function sharedLoad<K extends object, T>(load: (key: K) => Promise<T>) {
  const loads = new WeakMap<K, Promise<T>>();
  return (key: K): Promise<T> => {
    const existing = loads.get(key);
    if (existing) return existing;
    const promise = load(key).catch((error: unknown) => {
      if (loads.get(key) === promise) loads.delete(key);
      throw error;
    });
    loads.set(key, promise);
    return promise;
  };
}
