import { describe, expect, it } from "vite-plus/test";

import { keepOrder } from "./useOrderWhileOpen";

describe("keepOrder", () => {
  it("keeps the opening order and puts new items after it", () => {
    const key = (item: string) => item;
    // "c" was pinned and moved to the top; "d" arrived after the list opened; "b" is gone.
    expect(keepOrder(["c", "d", "a"], ["a", "b", "c"], key)).toEqual(["a", "c", "d"]);
    expect(keepOrder(["c", "a"], null, key)).toEqual(["c", "a"]);
  });
});
