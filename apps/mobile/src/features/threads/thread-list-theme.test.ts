import { describe, expect, it } from "vite-plus/test";

import { createManagedThemeColors } from "@t3tools/themes";

import { getSidebarRowTextColor } from "./thread-list-theme";

describe("getSidebarRowTextColor", () => {
  it("keeps foreground and muted text on their canonical sidebar roles", () => {
    const colors = createManagedThemeColors("light", "#f2e1f4", "#9b2c7d");

    expect(getSidebarRowTextColor(colors, "foreground")).toBe(colors.sidebarForeground);
    expect(getSidebarRowTextColor(colors, "muted")).toBe(colors.sidebarMutedForeground);
  });

  it("leaves the stock palette on its existing stylesheet tokens", () => {
    expect(getSidebarRowTextColor(null, "foreground")).toBeUndefined();
    expect(getSidebarRowTextColor(undefined, "muted")).toBeUndefined();
  });
});
