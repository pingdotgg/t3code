import { describe, expect, it } from "vite-plus/test";

import { competingBetween, describeFailure, percentile } from "./report.ts";

describe("percentile", () => {
  it("takes the nearest-rank p90, a value that was measured", () => {
    expect(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 90)).toBe(90);
    expect(percentile([5, 1, 3], 90)).toBe(5);
    expect(percentile([], 90)).toBeNull();
  });
});

describe("competingBetween", () => {
  it.each([
    ["a process that kept running", [["10:500", 900]], [["10:500", 960]], 60],
    ["a new process, counted whole", [], [["11:700", 30]], 30],
    ["a reused pid is a new process", [["10:500", 900]], [["10:800", 300]], 300],
    ["a process that exited is lost", [["10:500", 900]], [], 0],
  ] as const)("%s", (_name, before, after, seconds) => {
    expect(competingBetween(new Map(before), new Map(after))).toBe(seconds);
  });
});

describe("describeFailure", () => {
  it.each([
    ["a plain error", new Error("boom"), "boom"],
    [
      "an RPC error wrapping the server's",
      new Error("RpcClientError", { cause: new Error("Command x was already handled") }),
      "RpcClientError: Command x was already handled",
    ],
    ["a tagged error with no message", { _tag: "TimeoutError" }, "TimeoutError"],
    [
      "a cause that repeats its wrapper",
      new Error("lost: gone", { cause: new Error("gone") }),
      "lost: gone",
    ],
    ["a string", "exit 1", "exit 1"],
  ])("%s", (_name, error, expected) => {
    expect(describeFailure(error)).toBe(expected);
  });
});
