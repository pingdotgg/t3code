import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleDiffWorkerPoolWarmup, warmDiffWorkerPool } from "../lib/diffWorkerWarmup";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DiffWorkerPoolProvider warmup helpers", () => {
  it("warms the worker pool with its current render options", async () => {
    const options = { theme: "pierre-light" };
    const workerPool = {
      getDiffRenderOptions: vi.fn(() => options),
      setRenderOptions: vi.fn().mockResolvedValue(undefined),
    } as const;

    await warmDiffWorkerPool(workerPool);

    expect(workerPool.getDiffRenderOptions).toHaveBeenCalledTimes(1);
    expect(workerPool.setRenderOptions).toHaveBeenCalledWith(options);
  });

  it("swallows worker warmup failures", async () => {
    const workerPool = {
      getDiffRenderOptions: vi.fn(() => ({ theme: "pierre-light" })),
      setRenderOptions: vi.fn().mockRejectedValue(new Error("warmup failed")),
    } as const;

    await expect(warmDiffWorkerPool(workerPool)).resolves.toBeUndefined();
  });

  it("schedules warmup exactly once per helper call", () => {
    const workerPool = {
      getDiffRenderOptions: vi.fn(() => ({ theme: "pierre-light" })),
      setRenderOptions: vi.fn().mockResolvedValue(undefined),
    } as const;
    const cancel = vi.fn();
    const scheduleTask = vi.fn((task: () => void) => {
      task();
      return cancel;
    });

    const cleanup = scheduleDiffWorkerPoolWarmup(workerPool, scheduleTask);

    expect(scheduleTask).toHaveBeenCalledTimes(1);
    expect(workerPool.setRenderOptions).toHaveBeenCalledTimes(1);
    expect(cleanup).toBe(cancel);
  });
});
