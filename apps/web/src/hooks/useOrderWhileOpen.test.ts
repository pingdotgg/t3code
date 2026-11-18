import { describe, expect, it } from "vite-plus/test";

import { keepOrder, withArrivedKeys } from "./useOrderWhileOpen";

describe("keepOrder", () => {
  it("keeps the opening order and puts new items after it", () => {
    const key = (item: string) => item;
    // "c" was pinned and moved to the top; "d" arrived after the list opened; "b" is gone.
    expect(keepOrder(["c", "d", "a"], ["a", "b", "c"], key)).toEqual(["a", "c", "d"]);
    expect(keepOrder(["c", "a"], null, key)).toEqual(["c", "a"]);
  });

  it("holds rows that arrived after opening in their first place", () => {
    // "b" and "c" load from another machine after the list opened with nothing in it.
    const order = withArrivedKeys(null, ["b", "c"]);
    expect(order).toEqual(["b", "c"]);
    // Pinning "c" moves it first in the source list; the shown order stays.
    expect(keepOrder(["c", "b"], order, (item) => item)).toEqual(["b", "c"]);
    expect(withArrivedKeys(order, ["b", "c"])).toBe(order);
  });
});
