import { describe, expect, it } from "vite-plus/test";

import { createSchemeNeutralSplashConfig, SCHEME_NEUTRAL_SPLASH_BACKGROUND } from "./splashConfig";

describe("scheme-neutral splash config", () => {
  it("uses one appearance-independent splash variant", () => {
    const splash = createSchemeNeutralSplashConfig("./icon.png");

    expect(splash).toEqual({
      image: "./icon.png",
      resizeMode: "contain",
      backgroundColor: SCHEME_NEUTRAL_SPLASH_BACKGROUND,
      imageWidth: 220,
    });
    expect(splash).not.toHaveProperty("dark");
  });
});
