import { describe, expect, it } from "vitest";

import {
  clampThreadSidebarWidth,
  resolveInitialThreadSidebarWidth,
  resolveThreadSidebarMaximumWidth,
  resolveThreadSidebarMinimumWidth,
} from "./threadSidebarWidth";

function renderedWidthAfterViewportChange(
  storedWidth: number | null,
  startupViewportWidth: number,
  viewportWidth: number,
): number {
  const sidebarWidth = resolveInitialThreadSidebarWidth(storedWidth, startupViewportWidth);
  const minimumWidth = resolveThreadSidebarMinimumWidth(0);
  return clampThreadSidebarWidth(
    sidebarWidth,
    minimumWidth,
    resolveThreadSidebarMaximumWidth(viewportWidth, minimumWidth),
  );
}

describe("thread sidebar width", () => {
  it("restores the stored width when the viewport widens after a narrow startup", () => {
    expect(renderedWidthAfterViewportChange(350, 840, 1638)).toBe(350);
  });

  it("restores the default width when the viewport widens after a narrow startup", () => {
    expect(renderedWidthAfterViewportChange(null, 840, 1638)).toBe(256);
  });
});
