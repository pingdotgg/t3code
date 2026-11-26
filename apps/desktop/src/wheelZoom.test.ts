import { assert, describe, it } from "@effect/vitest";

import { makeWheelZoomStepper } from "./wheelZoom.ts";

describe("makeWheelZoomStepper", () => {
  it("steps once per mouse notch, even quick zoomed-in ones", () => {
    let zoom = 1;
    const step = makeWheelZoomStepper(() => zoom);
    const steps = [0, 60, 120].map((timeStamp) => {
      const direction = step({ deltaY: -40 / zoom, timeStamp });
      if (direction === "in") zoom *= 1.2 ** 0.5;
      return direction;
    });
    assert.deepEqual(steps, ["in", "in", "in"]);
  });

  it("steps once per 36px of continuous trackpad scrolling", () => {
    const step = makeWheelZoomStepper(() => 1);
    const steps = Array.from({ length: 17 }, (_, index) =>
      step({ deltaY: 5, timeStamp: index * 16 }),
    ).filter((direction) => direction !== null);
    // The first event, then a step after each further 8 events (40px).
    assert.deepEqual(steps, ["out", "out", "out"]);
  });

  it("ignores horizontal scrolling", () => {
    const step = makeWheelZoomStepper(() => 1);
    assert.isNull(step({ deltaY: 0, timeStamp: 0 }));
  });
});
