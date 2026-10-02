import { describe, expect, it } from "vite-plus/test";

import { copySorted } from "./Array.ts";

describe("array copies", () => {
  it("sorts a copy without mutating the source", () => {
    const source = [3, 1, 2];

    expect(copySorted(source, (left: number, right: number) => left - right)).toEqual([1, 2, 3]);
    expect(source).toEqual([3, 1, 2]);
  });
});
