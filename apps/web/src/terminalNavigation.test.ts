import { assert, describe, it } from "vitest";
import { nextCycleIndex, nextDirectionalIndex } from "./terminalNavigation";

describe("nextCycleIndex", () => {
  it("returns null when length <= 1", () => {
    assert.isNull(nextCycleIndex(0, 0, "next"));
    assert.isNull(nextCycleIndex(0, 1, "next"));
    assert.isNull(nextCycleIndex(0, 1, "previous"));
  });

  it("advances forward and wraps around", () => {
    assert.strictEqual(nextCycleIndex(0, 3, "next"), 1);
    assert.strictEqual(nextCycleIndex(1, 3, "next"), 2);
    assert.strictEqual(nextCycleIndex(2, 3, "next"), 0);
  });

  it("steps backward and wraps around", () => {
    assert.strictEqual(nextCycleIndex(2, 3, "previous"), 1);
    assert.strictEqual(nextCycleIndex(1, 3, "previous"), 0);
    assert.strictEqual(nextCycleIndex(0, 3, "previous"), 2);
  });

  it("treats out-of-range or negative current index as 0", () => {
    assert.strictEqual(nextCycleIndex(-1, 3, "next"), 1);
    assert.strictEqual(nextCycleIndex(99, 3, "next"), 1);
    assert.strictEqual(nextCycleIndex(-1, 3, "previous"), 2);
  });
});

describe("nextDirectionalIndex", () => {
  it("returns null when current index is out of range", () => {
    assert.isNull(nextDirectionalIndex(-1, 3, "right"));
    assert.isNull(nextDirectionalIndex(3, 3, "right"));
    assert.isNull(nextDirectionalIndex(99, 3, "left"));
  });

  it("moves left and right within bounds", () => {
    assert.strictEqual(nextDirectionalIndex(0, 3, "right"), 1);
    assert.strictEqual(nextDirectionalIndex(1, 3, "right"), 2);
    assert.strictEqual(nextDirectionalIndex(2, 3, "left"), 1);
    assert.strictEqual(nextDirectionalIndex(1, 3, "left"), 0);
  });

  it("returns null at edges (no wrap)", () => {
    assert.isNull(nextDirectionalIndex(2, 3, "right"));
    assert.isNull(nextDirectionalIndex(0, 3, "left"));
  });

  it("returns null for single-element arrays", () => {
    assert.isNull(nextDirectionalIndex(0, 1, "right"));
    assert.isNull(nextDirectionalIndex(0, 1, "left"));
  });
});
