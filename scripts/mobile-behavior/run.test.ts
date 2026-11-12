import { expect, it } from "@effect/vitest";

import { scriptOf } from "./fake-fx.ts";
import { caseResult, checkFails, feedMotion, frameStats, type SampleRow } from "./grade.ts";

const steady = (count: number, gap: number) =>
  Array.from({ length: count }, (_, index) => index * gap);

it("counts the frames a long gap swallowed, against the device's own refresh rate", () => {
  const at120 = steady(120, 1000 / 120);
  expect(frameStats(at120, "ui")).toMatchObject({ uiRefreshHz: 120, uiDroppedPct: 0 });

  // One 50 ms stall at 60 Hz hides two frames.
  const stalled = [...steady(60, 1000 / 60), 59 * (1000 / 60) + 50];
  expect(frameStats(stalled, "js")).toMatchObject({ jsRefreshHz: 60, jsDroppedPct: 3.2 });

  // JS rAF fires on a timer, so a late frame makes the next gap short; the UI rate sets the budget.
  const jittered = steady(300, 1000 / 60).map((time, index) =>
    index % 15 === 7 ? time + 6 : time,
  );
  expect(frameStats(jittered, "js")).toMatchObject({ jsRefreshHz: 120 });
  expect(frameStats(jittered, "js", 1000 / 60)).toMatchObject({ jsRefreshHz: 60, jsDroppedPct: 0 });

  // A steady 20 FPS is two dropped frames in every three, not a slow display.
  expect(frameStats(steady(60, 50), "ui")).toMatchObject({ uiRefreshHz: 60, uiDroppedPct: 66.7 });
});

it("reads row motion on screen, so an offset change that keeps content still is not a jump", () => {
  const rows = (entries: Record<string, number>) => ({ threadId: "t", ready: true, rows: entries });
  // Scrolling up: rows move down the screen; the list then grows above and shifts its offset.
  const smooth = [rows({ a: 100, b: 400 }), rows({ a: 180, b: 480 }), rows({ a: 180, b: 480 })];
  expect(feedMotion(smooth, 1)).toMatchObject({ backwardPx: 0, teleports: 0, largestStepPx: 80 });

  const jerk = [rows({ a: 100 }), rows({ a: 180 }), rows({ a: 60 })];
  expect(feedMotion(jerk, 1)).toMatchObject({ backwardPx: 120 });

  const teleport = [rows({ a: 100 }), rows({ a: 1300 })];
  expect(feedMotion(teleport, 1)).toMatchObject({ teleports: 1, largestStepPx: 1200 });

  // A jump past every visible row leaves no shared row; the offset change is the move.
  const offset = (scroll: number, entries: Record<string, number>) => ({
    ...rows(entries),
    scroll,
    content: 9000,
  });
  expect(feedMotion([offset(6000, { a: 100 }), offset(1000, { z: 100 })], 1)).toMatchObject({
    teleports: 1,
    largestStepPx: 5000,
  });
});

it("fails a case when half or more of its graded samples fail", () => {
  const row = (pass: boolean | null, value: number): SampleRow => ({
    id: "c",
    device: "phone",
    sample: 1,
    pass,
    failures: [],
    metrics: { backwardPx: value },
  });
  expect(
    caseResult("c", "phone", "backwardPx", [row(true, 1), row(true, 3), row(false, 90)]),
  ).toMatchObject({
    pass: true,
    key: 3,
  });
  expect(caseResult("c", "phone", "backwardPx", [row(true, 1), row(false, 90)]).pass).toBe(false);
  expect(caseResult("c", "phone", "backwardPx", [row(null, 0)]).pass).toBe(null);

  // Errors that outnumber graded samples leave the case incomplete, not passing.
  const errored: SampleRow = { ...row(null, 0), error: "Inspector timed out" };
  expect(caseResult("c", "phone", "backwardPx", [row(true, 1), errored, errored])).toMatchObject({
    pass: null,
    errors: 2,
  });
});

it("checks exact values and bounds", () => {
  expect(checkFails({ metric: "rowStatus", equals: "input" }, { rowStatus: "working" })).toBe(
    "rowStatus=working, want input",
  );
  expect(checkFails({ metric: "backwardPx", max: 24 }, { backwardPx: 24 })).toBe(null);
  expect(checkFails({ metric: "contentGrewPx", min: 500 }, {})).toBe("contentGrewPx missing");
});

it("reads the fake provider's script from the prompt marker", () => {
  expect(scriptOf("Write it. [[eval:stream:4000:25]]")).toMatchObject({
    kind: "stream",
    words: 4000,
    chunkMs: 25,
  });
  expect(scriptOf("Run. [[eval:hold:bg-1]]")).toMatchObject({ kind: "hold", key: "bg-1" });
  expect(scriptOf("plain text")).toMatchObject({ kind: "reply" });
});
