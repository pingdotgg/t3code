import { describe, expect, it } from "vite-plus/test";

import { keepShallowEqual, keepUnchangedItems } from "./keepUnchanged";

describe("keepUnchangedItems", () => {
  const a = { id: "a", type: "diff", version: 1 };
  const b = { id: "b", type: "diff", version: 1 };

  it("keeps the previous list while every id, type and version matches", () => {
    const previous = [a, b];
    expect(keepUnchangedItems(previous, [{ ...a }, { ...b }])).toBe(previous);
  });

  it("takes an item whose version changed and keeps the others", () => {
    const changed = { ...b, version: 2 };
    const kept = keepUnchangedItems([a, b], [{ ...a }, changed]);
    expect(kept[0]).toBe(a);
    expect(kept[1]).toBe(changed);
  });

  it("returns a new list when items move, arrive, or leave", () => {
    expect(keepUnchangedItems([a, b], [{ ...b }, { ...a }])).toEqual([b, a]);
    expect(keepUnchangedItems([a], [{ ...a }, b])).toEqual([a, b]);
    const previous = [a, b];
    expect(keepUnchangedItems(previous, [{ ...a }])).not.toBe(previous);
  });
});

describe("keepShallowEqual", () => {
  const onPostRender = () => {};

  it("keeps the previous object until a value or key changes", () => {
    const previous = { theme: "dark", onPostRender };
    expect(keepShallowEqual(previous, { theme: "dark", onPostRender })).toBe(previous);
    const next = { theme: "light", onPostRender };
    expect(keepShallowEqual(previous, next)).toBe(next);
    const added = { theme: "dark", onPostRender, stickyHeaders: true };
    expect(keepShallowEqual(previous, added)).toBe(added);
  });
});
