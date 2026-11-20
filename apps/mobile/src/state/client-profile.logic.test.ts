import { describe, expect, it } from "@effect/vitest";
import { T3_CODE_DARK_THEME_COLORS } from "@t3tools/shared/themePalettes";
import { vi } from "vite-plus/test";

import { DEFAULT_FOLLOW_UP_BEHAVIOR } from "../lib/followUpBehavior";
import {
  buildMobileThemeRegistry,
  EMPTY_MOBILE_THEME_REGISTRY,
  setRegisteredMobileThemes,
} from "../lib/mobileThemeRegistry";
import type { Preferences } from "../persistence/mobile-preferences";
import {
  applyMobileProfileValues,
  mobileProfilePatch,
  readMobileProfileValues,
} from "./client-profile.logic";

const islandsDarkRegistry = buildMobileThemeRegistry({
  editorThemes: [
    {
      id: "islands-dark",
      label: "Islands Dark",
      appearance: "dark",
      colors: T3_CODE_DARK_THEME_COLORS,
    },
  ],
  servers: [],
  remembered: [],
});

describe("client profile mapping", () => {
  it("maps theme halves and never publishes material-you", () => {
    const values = readMobileProfileValues({ lightThemeId: "grove", darkThemeId: "material-you" });
    expect(values.themeLight).toBe("grove");
    expect(values).not.toHaveProperty("themeDark");
  });

  it("skips custom and environment theme ids and keeps legacy themeId on the active appearance", () => {
    expect(mobileProfilePatch({}, { themeDark: "custom-x" }, "light")).toEqual({});
    // An empty write still notifies subscribers, which would start another sync pass.
    const preferences: Preferences = { darkThemeId: "ocean" };
    const write = vi.fn((patch: Partial<Preferences>): Preferences => ({
      ...preferences,
      ...patch,
    }));
    expect(
      applyMobileProfileValues({
        preferences,
        values: { themeDark: "custom-x" },
        systemAppearance: "light",
        write,
      }),
    ).toEqual({ themeDark: "ocean" });
    expect(write).not.toHaveBeenCalled();
    expect(mobileProfilePatch({}, { themeDark: "material-you" }, "light")).toEqual({});
    expect(
      mobileProfilePatch({ themeMode: "dark" }, { themeDark: "ocean" }, "light"),
    ).toMatchObject({ darkThemeId: "ocean", themeId: "ocean" });
    expect(
      mobileProfilePatch(
        { themeMode: "system" },
        { themeLight: "grove", themeDark: "ocean" },
        "light",
      ),
    ).toMatchObject({ lightThemeId: "grove", darkThemeId: "ocean", themeId: "grove" });
  });

  it("applies a registered theme for the appearance it has", () => {
    setRegisteredMobileThemes(islandsDarkRegistry);
    try {
      expect(mobileProfilePatch({}, { themeDark: "islands-dark" }, "dark")).toMatchObject({
        darkThemeId: "islands-dark",
      });
    } finally {
      setRegisteredMobileThemes(EMPTY_MOBILE_THEME_REGISTRY);
    }
  });

  it("skips a registered theme for an appearance it lacks", () => {
    setRegisteredMobileThemes(islandsDarkRegistry);
    try {
      expect(mobileProfilePatch({}, { themeLight: "islands-dark" }, "dark")).not.toHaveProperty(
        "lightThemeId",
      );
    } finally {
      setRegisteredMobileThemes(EMPTY_MOBILE_THEME_REGISTRY);
    }
  });

  it("applies a theme id once its theme is registered", () => {
    try {
      expect(mobileProfilePatch({}, { themeDark: "islands-dark" }, "dark")).not.toHaveProperty(
        "darkThemeId",
      );
      setRegisteredMobileThemes(islandsDarkRegistry);
      expect(mobileProfilePatch({}, { themeDark: "islands-dark" }, "dark")).toMatchObject({
        darkThemeId: "islands-dark",
      });
    } finally {
      setRegisteredMobileThemes(EMPTY_MOBILE_THEME_REGISTRY);
    }
  });

  it("applies a synced chat width", () => {
    expect(mobileProfilePatch({}, { chatWidth: "full" }, "light")).toEqual({ chatWidth: "full" });
  });

  it("dual-writes the legacy grouping flag", () => {
    expect(mobileProfilePatch({}, { sidebarProjectGroupingMode: "separate" }, "light")).toEqual({
      projectGroupingMode: "separate",
      projectGroupingEnabled: false,
    });
  });

  it("reads effective defaults for unset preferences", () => {
    expect(readMobileProfileValues({})).toEqual({
      themeMode: "system",
      themeLight: "t3-code",
      themeDark: "t3-code",
      toolCallVisibility: "showAll",
      followUpBehavior: DEFAULT_FOLLOW_UP_BEHAVIOR,
      mathRenderingEnabled: false,
      sidebarProjectGroupingMode: "repository",
      sidebarWorkingShelfEnabled: true,
      chatWidth: "comfortable",
    });
  });

  it("skips invalid values", () => {
    expect(
      mobileProfilePatch(
        {},
        {
          toolCallVisibility: "loud",
          followUpBehavior: 3,
          mathRenderingEnabled: "yes",
          chatWidth: "huge",
        },
        "dark",
      ),
    ).toEqual({});
  });
});
