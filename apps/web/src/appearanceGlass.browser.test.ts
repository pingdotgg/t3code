import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { applyGlassAppearance } from "./appearanceGlass";

function renderedBackdropFilter(className: string, glassOpacity: number): string {
  const scope = document.createElement("div");
  const probe = document.createElement("div");
  probe.className = className;
  scope.append(probe);
  document.body.append(scope);
  try {
    applyGlassAppearance(scope, glassOpacity);
    return getComputedStyle(probe).backdropFilter;
  } finally {
    scope.remove();
  }
}

describe("applyGlassAppearance", () => {
  it("removes the backdrop filter entirely at full opacity", () => {
    for (const className of ["surface-glass", "dialog-glass", "dropdown-glass", "alert-glass"]) {
      expect(renderedBackdropFilter(className, 100), className).toBe("none");
    }
  });

  it("keeps the glass filter below full opacity", () => {
    expect(renderedBackdropFilter("dialog-glass", 80)).toContain("blur");
  });
});
