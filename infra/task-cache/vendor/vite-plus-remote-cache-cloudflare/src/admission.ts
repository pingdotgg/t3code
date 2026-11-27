import { HttpError } from './errors.ts';

export interface AdmissionOptions {
  stores: number;
  reads: number;
  /** How long a store waits for a free slot before failing. */
  storeWaitMs: number;
  /** How long a fetch or blob read waits for a free slot before failing. */
  readWaitMs: number;
  /** How often a waiting request checks for a free slot. */
  pollMs: number;
}

// A store buffers its value, so few run at once. A read holds only its request body and the
// lookups it makes in D1 and R2: values and blobs stream after its slot is released. Reads come in
// bursts, one lookup for every task of a build, so many run at once.
const defaults: AdmissionOptions = {
  stores: 2,
  reads: 32,
  storeWaitMs: 30_000,
  readWaitMs: 10_000,
  pollMs: 50,
};

// Isolate-wide resource counters contain no request data or I/O promises. They bound the
// requests an isolate serves at once, and so its simultaneous buffers. A request over the limit
// waits for a slot before failing, so a burst of requests from one build is served in turn. A
// waiting request has read none of its body.
// Waiters poll with their own timers rather than being woken by the releasing
// request, so no promise is resolved from another request's context.
export class Admission {
  private stores = 0;
  private reads = 0;
  private options: AdmissionOptions;
  constructor(options: Partial<AdmissionOptions> = {}) {
    this.options = { ...defaults, ...options };
  }
  private tryAcquire(store: boolean): (() => void) | undefined {
    if (store ? this.stores >= this.options.stores : this.reads >= this.options.reads) return;
    if (store) this.stores++;
    else this.reads++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (store) this.stores--;
      else this.reads--;
    };
  }
  async acquire(store: boolean, signal?: AbortSignal): Promise<() => void> {
    const until = Date.now() + (store ? this.options.storeWaitMs : this.options.readWaitMs);
    for (;;) {
      if (signal?.aborted) throw new HttpError(503, 'deadline');
      const release = this.tryAcquire(store);
      if (release) return release;
      if (Date.now() >= until) throw new HttpError(503, 'concurrency_limit');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, this.options.pollMs);
        signal?.addEventListener('abort', done, { once: true });
        function done() {
          clearTimeout(timer);
          signal?.removeEventListener('abort', done);
          resolve();
        }
      });
    }
  }
}
