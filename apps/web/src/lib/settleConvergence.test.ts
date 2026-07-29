import { describe, expect, it } from "vite-plus/test";

import { confirmSettleConverged } from "./settleConvergence";

function harness(readings: ReadonlyArray<boolean | null>) {
  const waits: number[] = [];
  let resyncs = 0;
  let index = 0;
  return {
    waits,
    resyncCount: () => resyncs,
    options: {
      readSettled: () => readings[Math.min(index++, readings.length - 1)] as boolean | null,
      requestResync: () => {
        resyncs += 1;
      },
      delay: async (ms: number) => {
        waits.push(ms);
      },
      delaysMs: [10, 20, 30] as const,
    },
  };
}

describe("confirmSettleConverged", () => {
  it("stops at the first check when the view already agrees", async () => {
    const h = harness([true]);
    await expect(confirmSettleConverged(h.options)).resolves.toBe("converged");
    expect(h.waits).toEqual([10]);
    expect(h.resyncCount()).toBe(0);
  });

  it("keeps checking while the view lags, then converges without a resync", async () => {
    const h = harness([false, false, true]);
    await expect(confirmSettleConverged(h.options)).resolves.toBe("converged");
    expect(h.waits).toEqual([10, 20, 30]);
    expect(h.resyncCount()).toBe(0);
  });

  it("requests a resync when the view never reflects the accepted settle", async () => {
    const h = harness([false, false, false]);
    await expect(confirmSettleConverged(h.options)).resolves.toBe("resync-requested");
    expect(h.waits).toEqual([10, 20, 30]);
    expect(h.resyncCount()).toBe(1);
  });

  it("leaves a thread that vanished from the shell alone", async () => {
    const h = harness([null]);
    await expect(confirmSettleConverged(h.options)).resolves.toBe("thread-absent");
    expect(h.resyncCount()).toBe(0);
  });
});
