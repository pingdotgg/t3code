import { describe, expect, it } from "vite-plus/test";

import { hasDeliberateGestureTravel, takeUniquePaletteIds } from "./modelPickerPrototypeState";

describe("takeUniquePaletteIds", () => {
  it("deduplicates before applying the palette limit", () => {
    expect([...takeUniquePaletteIds(["b", "a", "b", "c", "d"], 4)]).toEqual(["b", "a", "c", "d"]);
  });
});

describe("hasDeliberateGestureTravel", () => {
  it("does not treat the trigger's width as finger movement", () => {
    const touchDown = { x: 170, y: 100 };

    expect(hasDeliberateGestureTravel(touchDown, touchDown, 16)).toBe(false);
    expect(hasDeliberateGestureTravel(touchDown, { x: 180, y: 100 }, 16)).toBe(false);
    expect(hasDeliberateGestureTravel(touchDown, { x: 186, y: 100 }, 16)).toBe(true);
  });
});
