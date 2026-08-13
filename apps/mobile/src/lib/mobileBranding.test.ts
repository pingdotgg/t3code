import { describe, expect, it } from "vite-plus/test";

import { resolveMobileStageLabel } from "./mobileBranding";

describe("resolveMobileStageLabel", () => {
  it.each([
    ["development", "Dev"],
    ["preview", "Nightly"],
    ["production", "Alpha"],
    [undefined, "Alpha"],
  ])("maps %s builds to %s", (appVariant, expected) => {
    expect(resolveMobileStageLabel(appVariant)).toBe(expected);
  });
});
