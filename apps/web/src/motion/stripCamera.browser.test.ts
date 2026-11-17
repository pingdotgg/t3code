import { describe, expect, it } from "vite-plus/test";

import { moveStripCamera, stripCameraPosition } from "./stripCamera";

function mountStrip() {
  const scroller = document.createElement("div");
  scroller.style.cssText = "width: 400px; height: 100px; overflow-x: auto; overflow-y: hidden";
  const stage = document.createElement("div");
  stage.style.cssText = "width: 1600px; height: 100px";
  scroller.append(stage);
  document.body.append(scroller);
  return Object.assign(scroller, { stage, [Symbol.dispose]: () => scroller.remove() });
}

describe("moveStripCamera", () => {
  it("lets go of the strip when a retarget has less than a pixel left to travel", () => {
    using strip = mountStrip();
    moveStripCamera(strip, strip.stage, 400);
    const [move] = strip.stage.getAnimations();
    move!.currentTime = Number(move!.effect!.getComputedTiming().endTime) - 1;
    expect(400 - stripCameraPosition(strip)).toBeGreaterThan(0);
    expect(400 - stripCameraPosition(strip)).toBeLessThan(0.5);

    moveStripCamera(strip, strip.stage, 400);

    expect(strip.stage.getAnimations()).toHaveLength(0);
    expect(stripCameraPosition(strip)).toBe(400);
    strip.scrollLeft = 100;
    expect(strip.scrollLeft).toBe(100);
  });
});
