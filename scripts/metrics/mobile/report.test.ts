import { expect, it } from "@effect/vitest";

import {
  flatten,
  soakCaseDeltas,
  soakGrowth,
  stepOf,
  type MobileMetrics,
  type PerfWindow,
} from "./report.ts";

const frames = (from: number, count: number, gap = 1000 / 60) =>
  Array.from({ length: count }, (_, index) => from + index * gap);

const window = (overrides: Partial<PerfWindow>): PerfWindow => ({
  startedAt: 0,
  inputs: [],
  commits: [],
  content: [],
  keys: [],
  js: [],
  ui: [],
  renders: null,
  heapBytes: null,
  ...overrides,
});

it("times a tap from its touch end, and counts only what happened after it", () => {
  const step = stepOf(
    window({
      inputs: [
        { kind: "touch-start", at: 100 },
        { kind: "touch-end", at: 180 },
      ],
      // The first commit is the harness's own perfStart call, before the tap.
      commits: [
        { at: 50, ms: 9 },
        { at: 260, ms: 30 },
        { at: 420, ms: 12 },
      ],
      content: [
        { thread: "env:other", at: 200, frameAt: 210 },
        { thread: "env:target", at: 400, frameAt: 415 },
      ],
      js: frames(0, 60),
    }),
    { case: "switch-long", step: "open", visit: "first", round: 1 },
    "target",
  );
  expect(step).toMatchObject({ contentMs: 235, settledMs: 240, commits: 2, commitMs: 42 });
});

it("measures typing from the first key, and reports no content without a target", () => {
  const step = stepOf(
    window({
      inputs: [
        { kind: "key", at: 1000 },
        { kind: "key", at: 1100 },
      ],
      commits: [{ at: 1010, ms: 4 }],
      keys: [20, 12, 16],
    }),
    { case: "type", step: "keys", visit: "step", round: 1 },
    null,
  );
  expect(step).toMatchObject({ contentMs: null, settledMs: 10, keyP50Ms: 16, keyP90Ms: 20 });
});

it("takes each run's median as one sample, so steps of one launch never pass for runs", () => {
  const step = (contentMs: number) =>
    stepOf(
      window({
        inputs: [{ kind: "touch-end", at: 0 }],
        content: [{ thread: "t", at: contentMs, frameAt: contentMs }],
      }),
      { case: "switch-short", step: "open", visit: "revisit", round: 1 },
      "t",
    );
  const metrics: MobileMetrics = {
    meta: {},
    runs: [
      { steps: [step(100), step(300), step(200)], memory: [] },
      { steps: [step(400)], memory: [{ label: "launch", heapMB: 80, processMB: null }] },
    ],
  };
  const flat = flatten(metrics);
  expect(flat.get("switch-short.open.revisit.contentMs")).toEqual([200, 400]);
  expect(flat.get("memory.launch.heapMB")).toEqual([80]);
  expect(flat.has("memory.launch.processMB")).toBe(false);
});

it("times a native menu item from its JS handler, since the tap never reaches JS as a touch", () => {
  const step = stepOf(
    window({
      inputs: [{ kind: "menu-action", at: 500 }],
      commits: [
        { at: 520, ms: 10 },
        { at: 700, ms: 40 },
      ],
    }),
    { case: "diff", step: "review", visit: "step", round: 1 },
    null,
  );
  expect(step).toMatchObject({ settledMs: 200, commits: 2 });
});

it("fits soak growth past warm-up per iteration, and names the case that grew the heap", () => {
  const samples = [
    { iteration: 0, case: "start", heapMB: 90, processMB: null },
    // Warm-up: the first iteration loads code and caches.
    { iteration: 1, case: "a", heapMB: 140, processMB: null },
    { iteration: 1, case: "b", heapMB: 150, processMB: null },
    { iteration: 2, case: "a", heapMB: 150, processMB: null },
    { iteration: 2, case: "b", heapMB: 152, processMB: null },
    { iteration: 3, case: "a", heapMB: 152, processMB: null },
    { iteration: 3, case: "b", heapMB: 154, processMB: null },
  ];
  expect(soakGrowth(samples)).toMatchObject({ heapMB: 2 });
  expect(soakCaseDeltas(samples).find((entry) => entry.case === "b")?.medianMB).toBe(2);
});
