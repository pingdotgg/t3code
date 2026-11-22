import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { applyGlassOpacity } from "./appearanceGlass";

function renderedBackdropFilter(className: string): string {
  const probe = document.createElement("div");
  probe.className = className;
  document.body.append(probe);
  try {
    return getComputedStyle(probe).backdropFilter;
  } finally {
    probe.remove();
  }
}

describe("applyGlassOpacity", () => {
  it("drops the backdrop filter entirely at full opacity", () => {
    const root = document.documentElement;
    const style = root.getAttribute("style");
    try {
      // A non-"none" backdrop-filter costs a compositor pass even at blur(0px).
      applyGlassOpacity(root, 100);
      expect(renderedBackdropFilter("surface-glass")).toBe("none");
      expect(renderedBackdropFilter("glass-backdrop")).toBe("none");

      applyGlassOpacity(root, 80);
      expect(renderedBackdropFilter("surface-glass")).toContain("blur(");
      expect(renderedBackdropFilter("glass-backdrop")).toContain("blur(");
    } finally {
      if (style === null) root.removeAttribute("style");
      else root.setAttribute("style", style);
    }
  });
});
