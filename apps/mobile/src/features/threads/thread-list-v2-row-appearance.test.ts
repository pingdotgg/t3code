import { describe, expect, it } from "vite-plus/test";
import { MOBILE_THEME_IDS } from "@t3tools/shared/themePalettes";

import { getMobileThemeVariables } from "../../lib/mobileTheme";
import { getThreadListV2RowAppearance as iosAppearance } from "./thread-list-v2-row-appearance";
import { getThreadListV2RowAppearance as androidAppearance } from "./thread-list-v2-row-appearance.android";

describe.each([
  ["ios", iosAppearance],
  ["android", androidAppearance],
] as const)("%s thread row colors", (_platform, appearanceFor) => {
  it.each(MOBILE_THEME_IDS)(
    "preserves active selection and uses neutral hover for %s",
    (themeId) => {
      for (const appearance of ["light", "dark"] as const) {
        const theme = getMobileThemeVariables(themeId, appearance);
        const idle = appearanceFor(theme, true, false);
        const active = appearanceFor(theme, true, true);

        expect(idle.style?.backgroundColor).toBe(theme["--color-drawer"]);
        expect(idle.interactionClassName).toBe("bg-thread-hover");
        expect(idle.interactionOpacity).toBe(1);
        expect(active.style?.backgroundColor).toBe(theme["--color-thread-selected"]);
        // Pointer feedback must not mix a second color into the active background.
        expect(active.interactionOpacity).toBe(0);
        expect(active.providerIconSurfaceColor).toBe(active.style?.backgroundColor);
        expect(idle.foregroundClassName).toBe("text-drawer-foreground");
        expect(idle.mutedForegroundClassName).toBe("text-drawer-foreground-muted");

        const phone = appearanceFor(theme, false, false);
        expect(phone.swipeBackgroundColor).toBe(theme["--color-screen"]);
        expect(phone.interactionClassName).toBe("bg-row-hover");
        expect(phone.foregroundClassName).toBe("text-foreground");
      }
    },
  );
});
