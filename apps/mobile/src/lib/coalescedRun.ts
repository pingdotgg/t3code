/**
 * Runs `run` at most once at a time. A call made while a run is in flight
 * queues one more run after it and returns that queued run, so input that
 * arrives mid-run (a native share handed over on resume) is still read, and
 * the caller that asked for it sees how it ended.
 */
export function coalescedRun(run: () => Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let queued: Promise<void> | null = null;
  const start = (): Promise<void> => {
    if (inFlight) {
      queued ??= inFlight
        .catch(() => undefined)
        .then(() => {
          queued = null;
          return start();
        });
      return queued;
    }
    inFlight = run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
  return start;
}
