import { describe, expect, it, vi } from "vite-plus/test";

import { coalescedRun } from "./coalescedRun";

function deferredRuns() {
  const runs: Array<PromiseWithResolvers<void>> = [];
  const run = () => {
    const next = Promise.withResolvers<void>();
    runs.push(next);
    return next.promise;
  };
  return { runs, run };
}

describe("coalescedRun", () => {
  it("queues one more run for calls made while a run is in flight", async () => {
    const { runs, run } = deferredRuns();
    const refresh = coalescedRun(run);

    const first = refresh();
    const second = refresh();
    const third = refresh();
    expect(third).toBe(second);
    expect(runs).toHaveLength(1);

    runs[0]!.resolve();
    await first;
    await vi.waitFor(() => expect(runs).toHaveLength(2));

    runs[1]!.resolve();
    await second;
    expect(runs).toHaveLength(2);
  });

  it("hands a queued run's failure to the call that asked for it", async () => {
    const { runs, run } = deferredRuns();
    const refresh = coalescedRun(run);

    const first = refresh();
    const second = refresh();
    runs[0]!.resolve();
    await first;
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    runs[1]!.reject(new Error("read failed"));
    await expect(second).rejects.toThrow("read failed");
  });

  it("runs once per call when calls do not overlap", async () => {
    let count = 0;
    const refresh = coalescedRun(async () => {
      count += 1;
    });
    await refresh();
    await refresh();
    expect(count).toBe(2);
  });
});
