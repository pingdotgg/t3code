/**
 * Push admission (src/Git/RepoObject.ts `pushPermitsFor`): the permit a
 * push takes from the isolate-wide memory gate must reflect what it can
 * hold at once — a spilled push never its body, an in-memory push never
 * the caches' ceilings (DESIGN §21.2, §22.5).
 */
import {
  BACKPRESSURE_BYTES,
  RETAIN_BYTES,
} from "@/Git/Store/StreamingSource.ts";
import {
  MAX_PACK_BYTES,
  PUSH_MEMORY_BUDGET_MB,
  pushPermitsFor,
  STAGE_BATCH_BYTES,
} from "@/Git/RepoObject.ts";
import { describe, expect, test } from "alchemy-test";

const MiB = 1024 * 1024;
const spilled = Math.ceil(
  (RETAIN_BYTES + BACKPRESSURE_BYTES + STAGE_BATCH_BYTES) / MiB,
);

describe("pushPermitsFor", () => {
  test("a spilled push is charged its working set, never its body", () => {
    expect(pushPermitsFor(MAX_PACK_BYTES + 1)).toBe(spilled);
    expect(pushPermitsFor(400 * MiB)).toBe(spilled);
    expect(pushPermitsFor(undefined)).toBe(spilled);
    expect(pushPermitsFor(Number.NaN)).toBe(spilled);
    expect(spilled).toBeLessThan(PUSH_MEMORY_BUDGET_MB);
  });

  test("an in-memory push is charged by its size; tiny pushes stay cheap", () => {
    expect(pushPermitsFor(0)).toBe(1);
    expect(pushPermitsFor(1024)).toBe(3);
    expect(pushPermitsFor(MAX_PACK_BYTES)).toBe(2 * (MAX_PACK_BYTES / MiB) + 1);
    // Several small pushes fit alongside one large one.
    expect(spilled + 4 * pushPermitsFor(1024)).toBeLessThanOrEqual(
      PUSH_MEMORY_BUDGET_MB,
    );
  });
});
