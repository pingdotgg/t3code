import { describe, expect, it } from "vitest";

import { resolveSettingsToggleNavigation } from "./settingsToggle";

describe("resolveSettingsToggleNavigation", () => {
  it("opens settings and remembers the full prior location", () => {
    expect(
      resolveSettingsToggleNavigation({
        pathname: "/thread-1",
        href: "/thread-1?diff=1#panel",
        previousLocation: null,
      }),
    ).toEqual({
      destination: "settings",
      previousLocation: { href: "/thread-1?diff=1#panel" },
      restoreHref: null,
    });
  });

  it("restores the remembered full location when settings is toggled again", () => {
    expect(
      resolveSettingsToggleNavigation({
        pathname: "/settings",
        href: "/settings",
        previousLocation: { href: "/thread-1?diff=1#panel" },
      }),
    ).toEqual({
      destination: "restore-previous",
      previousLocation: null,
      restoreHref: "/thread-1?diff=1#panel",
    });
  });

  it("has no restore target when settings is toggled without a remembered location", () => {
    expect(
      resolveSettingsToggleNavigation({
        pathname: "/settings",
        href: "/settings",
        previousLocation: null,
      }),
    ).toEqual({
      destination: "restore-previous",
      previousLocation: null,
      restoreHref: null,
    });
  });
});
