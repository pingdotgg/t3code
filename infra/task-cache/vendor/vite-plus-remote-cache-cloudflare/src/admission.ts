import { HttpError } from './errors.ts';

// Isolate-wide resource counters contain no request data or I/O promises. Rate
// limiting controls traffic; these counters additionally bound simultaneous buffers.
export class Admission {
  private stores = 0;
  private reads = 0;
  acquire(store: boolean): () => void {
    if (store ? this.stores >= 2 : this.reads >= 4) throw new HttpError(503, 'concurrency_limit');
    if (store) this.stores++;
    else this.reads++;
    return () => {
      if (store) this.stores--;
      else this.reads--;
    };
  }
}
