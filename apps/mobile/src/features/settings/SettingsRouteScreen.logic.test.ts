import { describe, expect, it } from "vite-plus/test";

import { resolveAgentAwarenessPlatformPresentation } from "./SettingsRouteScreen.logic";

describe("resolveAgentAwarenessPlatformPresentation", () => {
  it("supports agent awareness settings on Android", () => {
    expect(resolveAgentAwarenessPlatformPresentation("android")).toEqual({
      supported: true,
      subtitle: undefined,
    });
  });
});
