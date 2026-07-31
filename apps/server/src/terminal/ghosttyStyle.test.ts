import { describe, expect, it } from "vite-plus/test";

import {
  ghosttyThemeSearchPaths,
  mergeGhosttyColors,
  parseGhosttyConfig,
  splitThemeSelection,
} from "./ghosttyStyle.ts";

const posixPath = {
  isAbsolute: (value: string) => value.startsWith("/"),
  join: (...segments: ReadonlyArray<string>) =>
    segments
      .map((segment, index) =>
        index === 0 ? segment.replace(/\/$/, "") : segment.replace(/^\//, ""),
      )
      .join("/"),
};

const windowsPath = {
  isAbsolute: (value: string) => /^[A-Za-z]:[\\/]/.test(value),
  join: (...segments: ReadonlyArray<string>) => segments.join("\\"),
};

describe("parseGhosttyConfig", () => {
  it("resets scalar and palette colors with empty assignments", () => {
    const config = parseGhosttyConfig(`
      background = #000000
      foreground = #ffffff
      palette = 0=#111111
      palette = 1=#222222
      background =
      foreground = ""
      palette = 0=
      cursor-color = #c0ffee
    `);

    expect(config.colors.background).toBe("");
    expect(config.colors.foreground).toBe("");
    expect(config.colors.cursor).toBe("#c0ffee");
    expect(config.colors.palette[0]).toBe("");
    expect(config.colors.palette[1]).toBe("#222222");
  });

  it("keeps explicit color clears when merging user config over a theme", () => {
    const theme = parseGhosttyConfig(`
      background = #000000
      palette = 0=#111111
      palette = 1=#222222
    `);
    const user = parseGhosttyConfig(`
      background =
      palette = 0=
    `);

    const colors = mergeGhosttyColors(theme.colors, user.colors);

    expect(colors.background).toBe("");
    expect(colors.palette[0]).toBe("");
    expect(colors.palette[1]).toBe("#222222");
  });
});

describe("splitThemeSelection", () => {
  it("keeps a Windows absolute theme path as a bare selection", () => {
    expect(splitThemeSelection("C:/Users/Alex/Ghostty Themes/t3code")).toEqual({
      light: "C:/Users/Alex/Ghostty Themes/t3code",
      dark: "C:/Users/Alex/Ghostty Themes/t3code",
    });
  });

  it("still parses explicit light and dark theme selections", () => {
    expect(splitThemeSelection("light:Day,dark:Night")).toEqual({
      light: "Day",
      dark: "Night",
    });
  });
});

describe("ghosttyThemeSearchPaths", () => {
  it("searches beside the macOS Application Support config", () => {
    const candidates = ghosttyThemeSearchPaths(posixPath, {
      home: "/Users/alex",
      xdgConfigHome: "/Users/alex/.config",
      themeName: "t3code",
    });

    expect(candidates).toContain(
      "/Users/alex/Library/Application Support/com.mitchellh.ghostty/themes/t3code",
    );
  });

  it("tries an absolute theme file before named-theme directories", () => {
    const candidates = ghosttyThemeSearchPaths(windowsPath, {
      home: "C:\\Users\\alex",
      xdgConfigHome: "C:\\Users\\alex\\.config",
      themeName: "D:\\themes\\t3code",
    });

    expect(candidates[0]).toBe("D:\\themes\\t3code");
  });
});
