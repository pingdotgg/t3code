import { describe, expect, it } from "vite-plus/test";

import { runBulkLaunchQueue } from "./bulkLaunchQueue";

describe("runBulkLaunchQueue", () => {
  it("launches sequentially and waits between launches but not after the last", async () => {
    const events: Array<string> = [];
    let inFlight = 0;

    const outcome = await runBulkLaunchQueue({
      items: ["a", "b", "c"],
      delayMs: 10,
      sleep: async (ms) => {
        events.push(`sleep:${ms}`);
      },
      launch: async (item) => {
        inFlight += 1;
        expect(inFlight).toBe(1);
        events.push(`launch:${item}`);
        inFlight -= 1;
      },
    });

    expect(events).toEqual(["launch:a", "sleep:10", "launch:b", "sleep:10", "launch:c"]);
    expect(outcome).toEqual({ started: ["a", "b", "c"], failed: [], cancelled: [] });
  });

  it("keeps going after a failed launch and reports it", async () => {
    const outcome = await runBulkLaunchQueue({
      items: ["a", "b", "c"],
      delayMs: 0,
      launch: async (item) => {
        if (item === "b") {
          throw new Error("boom");
        }
      },
    });

    expect(outcome.started).toEqual(["a", "c"]);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]?.item).toBe("b");
    expect(outcome.cancelled).toEqual([]);
  });

  it("stops before the next launch when cancelled and reports the remainder", async () => {
    const launched: Array<string> = [];
    let cancelled = false;

    const outcome = await runBulkLaunchQueue({
      items: ["a", "b", "c"],
      delayMs: 0,
      isCancelled: () => cancelled,
      launch: async (item) => {
        launched.push(item);
        cancelled = true;
      },
    });

    expect(launched).toEqual(["a"]);
    expect(outcome.started).toEqual(["a"]);
    expect(outcome.cancelled).toEqual(["b", "c"]);
  });

  it("reports progress after each attempt", async () => {
    const progress: Array<string> = [];

    await runBulkLaunchQueue({
      items: ["a", "b"],
      delayMs: 0,
      onProgress: ({ completed, total }) => progress.push(`${completed}/${total}`),
      launch: async (item) => {
        if (item === "a") {
          throw new Error("boom");
        }
      },
    });

    expect(progress).toEqual(["1/2", "2/2"]);
  });
});
