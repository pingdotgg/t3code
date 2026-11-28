import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import { preserveReadingPosition } from "./preserveReadingPosition";

describe("preserveReadingPosition", () => {
  it("keeps the reader's line through a resize that lands before the first layout report", async () => {
    const scroller = document.createElement("div");
    scroller.style.cssText =
      "width: 600px; height: 300px; overflow-y: auto; font: 16px/20px serif;";
    // The marker fits one line at both widths, so whichever caret the probe picks shares its top.
    scroller.innerHTML = Array.from({ length: 30 }, (_, index) =>
      index === 15
        ? "<p>Marker line.</p>"
        : `<p>${"Filler words that wrap across several lines. ".repeat(8)}</p>`,
    ).join("");
    document.body.append(scroller);
    onTestFinished(() => scroller.remove());
    const markerText = [...scroller.querySelectorAll("p")][15]!.firstChild!;
    const markerTop = () => {
      const range = document.createRange();
      range.setStart(markerText, 0);
      range.collapse(true);
      return range.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    };

    const stop = preserveReadingPosition(scroller);
    onTestFinished(stop);
    scroller.scrollTop += markerTop() - 24;
    scroller.dispatchEvent(new Event("scroll"));
    const before = markerTop();
    scroller.style.width = "300px";

    await vi.waitFor(() => expect(Math.abs(markerTop() - before)).toBeLessThan(2));
  });
});
