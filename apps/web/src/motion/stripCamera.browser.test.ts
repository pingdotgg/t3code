import { describe, expect, it } from "vite-plus/test";

import { moveStripCamera, settleStripCamera, stripCameraPosition } from "./stripCamera";

function mountStrip() {
  const scroller = document.createElement("div");
  scroller.style.cssText = "width: 400px; height: 100px; overflow-x: auto; overflow-y: hidden";
  const stage = document.createElement("div");
  stage.style.cssText = "width: 1600px; height: 100px";
  scroller.append(stage);
  document.body.append(scroller);
  // The camera is module state: a move left running would carry into the next test.
  return Object.assign(scroller, {
    stage,
    [Symbol.dispose]: () => {
      settleStripCamera();
      scroller.remove();
    },
  });
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

  it("shows where the curve was at most two milliseconds ago, whenever a display samples it", () => {
    using strip = mountStrip();
    moveStripCamera(strip, strip.stage, 1200);
    const [move] = strip.stage.getAnimations();
    move!.pause();
    let late = 0;
    for (let t = 2.1; t < Number(move!.effect!.getComputedTiming().endTime); t += 0.37) {
      move!.currentTime = t - 2.01;
      const before = stripCameraPosition(strip);
      move!.currentTime = t;
      const shown = 1200 - new DOMMatrixReadOnly(getComputedStyle(strip.stage).transform).m41;
      if (shown < before - 1 || shown > stripCameraPosition(strip) + 1) late++;
    }
    expect(late).toBe(0);
  });
});
