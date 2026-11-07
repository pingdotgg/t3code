import { describe, assert, it } from "vite-plus/test";

import { createTurnItemOrdinalAllocator } from "./turnItemOrdinals.ts";

describe("createTurnItemOrdinalAllocator", () => {
  it("keeps the 100-item band values while a turn stays inside its band", () => {
    const allocator = createTurnItemOrdinalAllocator();
    const turnOne = new Map<string, number>();
    assert.equal(allocator.resolve(1, turnOne, "a"), 101);
    assert.equal(allocator.resolve(1, turnOne, "b"), 102);
    const turnTwo = new Map<string, number>();
    assert.equal(allocator.resolve(2, turnTwo, "c"), 201);
    assert.equal(allocator.resolve(2, turnTwo, "d"), 202);
  });

  it("returns the same ordinal for a native item id it already resolved", () => {
    const allocator = createTurnItemOrdinalAllocator();
    const turn = new Map<string, number>();
    assert.equal(allocator.resolve(3, turn, "tool-1"), 301);
    assert.equal(allocator.resolve(3, turn, "tool-1"), 301);
  });

  it("continues past a turn that overflows its band instead of colliding", () => {
    const allocator = createTurnItemOrdinalAllocator();
    const overflowingTurn = new Map<string, number>();
    const ordinals = Array.from({ length: 150 }, (_, index) =>
      allocator.resolve(1, overflowingTurn, `overflow-${index}`),
    );
    // The band base still holds for the first 100 items.
    assert.equal(ordinals[0], 101);
    assert.equal(ordinals[99], 200);
    // Items 101+ continue past the band instead of being cut off.
    assert.equal(ordinals[100], 201);
    assert.equal(ordinals[149], 250);

    const nextTurn = new Map<string, number>();
    assert.equal(allocator.resolve(2, nextTurn, "next"), 251);
    assert.notEqual(allocator.resolve(2, nextTurn, "next"), 201);
  });

  it("keeps later turns ahead of earlier overflow even when the band base is higher", () => {
    const allocator = createTurnItemOrdinalAllocator();
    const first = new Map<string, number>();
    for (let index = 0; index < 260; index += 1) allocator.resolve(1, first, `tool-${index}`);
    const second = new Map<string, number>();
    const nextOrdinal = allocator.resolve(2, second, "tool-next");
    assert.equal(nextOrdinal, 361);
    for (const ordinal of first.values()) assert.notEqual(ordinal, nextOrdinal);
  });
});
