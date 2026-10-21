import { describe, expect, it } from "vite-plus/test";

import { getMobileThemeVariables } from "./mobileTheme";
import { createNativeComposerTheme } from "./nativeComposerTheme";

describe("native composer colors", () => {
  it("flattens Material You alpha colors over the composer rather than falling back to defaults", () => {
    const theme = createNativeComposerTheme({
      ...getMobileThemeVariables("t3-code", "light"),
      "--color-screen": "#ffffffff",
      "--color-composer-surface": "#ffffffff",
      "--color-subtle": "#0000000d",
      "--color-placeholder": "#0000009e",
      "--color-inline-skill-background": "#ffffffff",
      "--color-inline-skill-border": "#00000080",
    });
    expect(theme.chipBackground).toBe("#f2f2f2");
    expect(theme.placeholder).toBe("#616161");
    expect(theme.skillBorder).toBe("#7f7f7f");
  });
});
