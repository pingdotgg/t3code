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

it.each([475, 411, 300])("fills a %sdp cover row beside the compose button", (width) => {
  const metrics = floatingTabsMetrics(4, width, true);
  expect(metrics.pill + 2 * 16 + 12 + 56).toBe(width);
  expect(metrics.height).toBe(56);
});
