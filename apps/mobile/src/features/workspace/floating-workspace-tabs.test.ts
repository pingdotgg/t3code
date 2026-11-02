import { expect, it } from "vite-plus/test";

import { floatingTabsMetrics } from "./floating-workspace-tabs";
import { resolveAndroidNavigationStyle } from "../../lib/androidNavigationStyle";

it.each([
  [undefined, "Samsung", false, "one-ui"],
  [undefined, "samsung", false, "one-ui"],
  [undefined, "Google", false, "material"],
  [undefined, null, false, "material"],
  [undefined, "Google", true, "one-ui"],
  ["material", "Samsung", false, "material"],
  ["one-ui", "Google", false, "one-ui"],
  ["material", "Google", true, "material"],
] as const)(
  "resolves navigation preference %s on %s with preview %s",
  (preference, manufacturer, preview, expected) => {
    expect(resolveAndroidNavigationStyle(preference, manufacturer, preview)).toBe(expected);
  },
);

it.each([
  [475, 1, 56],
  [411, 1, 56],
  [475, 1.25, 70],
] as const)(
  "fills a %sdp cover row at scale %s with a %sdp compose button",
  (width, scale, fabSize) => {
    const metrics = floatingTabsMetrics(4, scale, fabSize, width, true);
    expect(metrics.sharesRow).toBe(true);
    expect(metrics.pill + 2 * 16 + 12 + fabSize).toBe(width);
    expect(metrics.height).toBe(fabSize);
  },
);

it("stacks compose above a full-width pill when a cover row is too narrow", () => {
  const metrics = floatingTabsMetrics(4, 1, 56, 300, true);
  expect(metrics.sharesRow).toBe(false);
  expect(metrics.pill).toBe(268);
  expect(metrics.fabOffset).toBe(68);
});
