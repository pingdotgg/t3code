import { describe, expect, it } from "vite-plus/test";
import * as NodeFS from "node:fs";

import { BUILT_IN_THEME_IDS, BUILT_IN_THEMES } from "@t3tools/shared/themePalettes";
import { DEFAULT_MOBILE_THEME_VARIABLES } from "./mobileDefaultTheme";

import {
  createMobileThemePairPatch,
  createMobileThemeSelectionPatch,
  createMobileThemeVariables,
  createUserBubbleOverrides,
  DEFAULT_MOBILE_THEME_ID,
  getMobileThemePreviewColors,
  getMobileThemeVariables,
  hexToHsv,
  hsvToHex,
  MOBILE_THEME_IDS,
  normalizeMobileThemeId,
  normalizeMobileThemeMode,
  normalizeUserBubbleColor,
  resolveMobileThemeIds,
  themeColorWithAlpha,
  themeColorToNativeColor,
} from "./mobileTheme";

function relativeLuminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)!
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

function compositeOver(overlay: string, background: string): string {
  const overlayMatch = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(overlay)!;
  const backgroundChannels = background
    .slice(1)
    .match(/.{2}/g)!
    .map((channel) => Number.parseInt(channel, 16));
  const alpha = Number(overlayMatch[4]);
  const channels = [1, 2, 3].map((index) =>
    Math.round(Number(overlayMatch[index]) * alpha + backgroundChannels[index - 1]! * (1 - alpha)),
  );
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

describe("mobile themes", () => {
  it("declares every runtime theme variable in the static stylesheet", () => {
    const stylesheet = NodeFS.readFileSync(new URL("../../global.css", import.meta.url), "utf8");
    const stylesheetVariables = new Set(
      Array.from(stylesheet.matchAll(/--color-[a-z0-9-]+/g), ([variable]) => variable),
    );

    expect(Array.from(stylesheetVariables).sort()).toEqual(
      Object.keys(DEFAULT_MOBILE_THEME_VARIABLES.light).sort(),
    );
  });

  it("shares all built-in desktop palettes", () => {
    expect(BUILT_IN_THEMES.map((theme) => theme.id)).toEqual(BUILT_IN_THEME_IDS);
    for (const themeId of BUILT_IN_THEME_IDS) {
      expect(getMobileThemeVariables(themeId, "light")["--color-screen"]).toMatch(/^#/);
      expect(getMobileThemeVariables(themeId, "dark")["--color-screen"]).toMatch(/^#/);
    }
  });

  it("preserves the existing mobile palette as the default", () => {
    expect(getMobileThemeVariables(DEFAULT_MOBILE_THEME_ID, "light")["--color-screen"]).toBe(
      "#f2f2f7",
    );
    expect(getMobileThemeVariables(DEFAULT_MOBILE_THEME_ID, "dark")["--color-screen"]).toBe(
      "#0a0a0a",
    );
    expect(
      getMobileThemeVariables(DEFAULT_MOBILE_THEME_ID, "light")[
        "--color-user-bubble-skill-foreground"
      ],
    ).toBe("#f0abfc");
  });

  it("applies palette overrides on top of the selected built-in theme", () => {
    const variables = getMobileThemeVariables("ocean", "dark", {
      "--color-primary": "#123456",
    });

    expect(variables["--color-primary"]).toBe("#123456");
    expect(variables["--color-screen"]).toMatch(/^#/);
  });

  it("uses the same preview roles and standard artwork as desktop", () => {
    expect(getMobileThemePreviewColors(DEFAULT_MOBILE_THEME_ID, "light")).toEqual({
      canvas: "#fcfcfc",
      accent: "#f4f4f5",
      messageAction: "#4f46e5",
    });
    const desktopOcean = BUILT_IN_THEMES.find((theme) => theme.id === "ocean")!;
    expect(getMobileThemePreviewColors("ocean", "light")).toEqual({
      canvas: themeColorToNativeColor(desktopOcean.colors.canvas),
      accent: themeColorToNativeColor(desktopOcean.colors.accent),
      messageAction: themeColorToNativeColor(desktopOcean.colors.messageAction),
    });
  });

  it("normalizes persisted theme preferences", () => {
    expect(normalizeMobileThemeId("ocean")).toBe("ocean");
    expect(normalizeMobileThemeId("missing-theme")).toBe(DEFAULT_MOBILE_THEME_ID);
    expect(normalizeMobileThemeMode("dark")).toBe("dark");
    expect(normalizeMobileThemeMode("sepia")).toBe("system");
  });

  it("migrates one theme choice to both appearances and preserves independent choices", () => {
    expect(resolveMobileThemeIds({ themeId: "grove" })).toEqual({
      light: "grove",
      dark: "grove",
    });
    expect(
      resolveMobileThemeIds({ themeId: "grove", lightThemeId: "iris", darkThemeId: "ocean" }),
    ).toEqual({ light: "iris", dark: "ocean" });
    expect(resolveMobileThemeIds({ themeId: "grove", lightThemeId: "missing" })).toEqual({
      light: DEFAULT_MOBILE_THEME_ID,
      dark: "grove",
    });
  });

  it("changes either theme without switching the active appearance", () => {
    const themeIds = { light: "t3-chat", dark: "grove" } as const;
    expect(createMobileThemeSelectionPatch(themeIds, "light", "dark", "ocean")).toEqual({
      lightThemeId: "t3-chat",
      darkThemeId: "ocean",
      themeId: "t3-chat",
    });
    expect(createMobileThemeSelectionPatch(themeIds, "light", "light", "iris")).toEqual({
      lightThemeId: "iris",
      darkThemeId: "grove",
      themeId: "iris",
    });
  });

  it("changes both appearance themes from the card action", () => {
    expect(createMobileThemePairPatch("ember")).toEqual({
      lightThemeId: "ember",
      darkThemeId: "ember",
      themeId: "ember",
    });
  });

  it("converts OKLCH colors to React Native sRGB ColorValues", () => {
    expect(themeColorToNativeColor("oklch(1 0 0)")).toBe("#ffffff");
    expect(themeColorToNativeColor("oklch(0 0 0)")).toBe("#000000");
    expect(themeColorToNativeColor("#123456")).toBe("#123456");
  });

  it("changes native palette color opacity for fades", () => {
    expect(themeColorWithAlpha("#123456", 0)).toBe("rgba(18, 52, 86, 0)");
    expect(themeColorWithAlpha("rgba(18, 52, 86, 0.98)", 0)).toBe("rgba(18, 52, 86, 0)");
  });

  it("maps semantic palette roles onto every mobile color variable", () => {
    const variables = createMobileThemeVariables(BUILT_IN_THEMES[0].colors, "light");
    expect(Object.keys(variables)).toHaveLength(65);
    expect(variables["--color-sheet-solid"]).toBe(
      themeColorToNativeColor(BUILT_IN_THEMES[0].colors.chrome),
    );
    expect(variables["--color-primary"]).not.toBe(variables["--color-screen"]);
    expect(variables["--color-primary-shadow"]).toBe("#000000");
    expect(variables["--color-backdrop"]).toBe("rgba(0, 0, 0, 0.22)");
    expect(variables["--color-drawer-shadow"]).toBe("rgba(0, 0, 0, 0.12)");
    expect(variables["--color-user-bubble-foreground"]).toMatch(/^#/);
    expect(Object.keys(DEFAULT_MOBILE_THEME_VARIABLES.light).sort()).toEqual(
      Object.keys(variables).sort(),
    );
    expect(Object.keys(DEFAULT_MOBILE_THEME_VARIABLES.dark).sort()).toEqual(
      Object.keys(variables).sort(),
    );
  });

  it("keeps every built-in shadow and backdrop black-based in dark mode", () => {
    for (const theme of BUILT_IN_THEMES) {
      const variables = getMobileThemeVariables(normalizeMobileThemeId(theme.id), "dark");
      expect(variables["--color-primary-shadow"]).toBe("#000000");
      expect(variables["--color-backdrop"]).toBe("rgba(0, 0, 0, 0.48)");
      expect(variables["--color-drawer-shadow"]).toBe("rgba(0, 0, 0, 0.32)");
    }
  });

  it("keeps placeholders and selected-row labels readable on their mobile surfaces", () => {
    for (const themeId of MOBILE_THEME_IDS) {
      for (const appearance of ["light", "dark"] as const) {
        const variables = getMobileThemeVariables(themeId, appearance);
        expect(
          contrastRatio(variables["--color-placeholder"], variables["--color-input"]),
        ).toBeGreaterThanOrEqual(4.5);
      }
    }

    for (const themeId of BUILT_IN_THEME_IDS) {
      for (const appearance of ["light", "dark"] as const) {
        const variables = getMobileThemeVariables(themeId, appearance);
        expect(
          contrastRatio(
            variables["--color-user-bubble-foreground"],
            variables["--color-user-bubble"],
          ),
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(
            variables["--color-user-bubble-skill-foreground"],
            variables["--color-user-bubble"],
          ),
        ).toBeGreaterThanOrEqual(4.5);
        expect(variables["--color-user-bubble-skill-foreground"]).not.toBe(
          variables["--color-user-bubble-foreground"],
        );
        const fenceSurface = compositeOver(
          variables["--color-md-user-fence-bg"],
          variables["--color-user-bubble"],
        );
        expect(fenceSurface).not.toBe(variables["--color-user-bubble"]);
        expect(
          contrastRatio(variables["--color-md-user-fence-text"], fenceSurface),
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("normalizes persisted sent-message colors to six-digit hex or null", () => {
    expect(normalizeUserBubbleColor("#34C759")).toBe("#34c759");
    expect(normalizeUserBubbleColor(" #abc ")).toBe("#aabbcc");
    expect(normalizeUserBubbleColor("34c759")).toBe(null);
    expect(normalizeUserBubbleColor("#34c7")).toBe(null);
    expect(normalizeUserBubbleColor("#gggggg")).toBe(null);
    expect(normalizeUserBubbleColor(null)).toBe(null);
    expect(normalizeUserBubbleColor(42)).toBe(null);
  });

  it("returns no sent-message overrides when both colors follow the theme", () => {
    const base = getMobileThemeVariables(DEFAULT_MOBILE_THEME_ID, "dark");
    expect(createUserBubbleOverrides(base, null, null)).toBe(null);
  });

  it("derives readable text and layered tokens for a custom bubble color", () => {
    const base = getMobileThemeVariables(DEFAULT_MOBILE_THEME_ID, "dark");

    const onLightBubble = createUserBubbleOverrides(base, "#ffe066", null)!;
    expect(onLightBubble["--color-user-bubble"]).toBe("#ffe066");
    expect(onLightBubble["--color-user-bubble-foreground"]).toBe("#000000");
    expect(onLightBubble["--color-user-bubble-foreground-muted"]).toBe("rgba(0, 0, 0, 0.78)");
    expect(onLightBubble["--color-md-user-code-text"]).toBe("#000000");
    expect(
      contrastRatio(onLightBubble["--color-user-bubble-skill-foreground"]!, "#ffe066"),
    ).toBeGreaterThanOrEqual(4.5);

    const onDarkBubble = createUserBubbleOverrides(base, "#1c1c1e", null)!;
    expect(onDarkBubble["--color-user-bubble-foreground"]).toBe("#ffffff");
  });

  it("keeps the theme bubble when only the text color is custom", () => {
    const base = getMobileThemeVariables(DEFAULT_MOBILE_THEME_ID, "light");
    const overrides = createUserBubbleOverrides(base, null, "#000000")!;
    expect(overrides["--color-user-bubble"]).toBe(base["--color-user-bubble"]);
    expect(overrides["--color-user-bubble-foreground"]).toBe("#000000");
    expect(overrides["--color-md-user-fence-text"]).toBe("#000000");
  });

  it("prefers an explicit text color over the derived one", () => {
    const base = getMobileThemeVariables(DEFAULT_MOBILE_THEME_ID, "light");
    const overrides = createUserBubbleOverrides(base, "#ffe066", "#ffffff")!;
    expect(overrides["--color-user-bubble-foreground"]).toBe("#ffffff");
  });

  it("converts between hex and HSV for the color picker", () => {
    expect(hsvToHex({ h: 0, s: 1, v: 1 })).toBe("#ff0000");
    expect(hsvToHex({ h: 120, s: 1, v: 1 })).toBe("#00ff00");
    expect(hsvToHex({ h: 240, s: 1, v: 1 })).toBe("#0000ff");
    expect(hsvToHex({ h: 300, s: 0, v: 1 })).toBe("#ffffff");
    expect(hsvToHex({ h: 45, s: 0.6, v: 0 })).toBe("#000000");

    expect(hexToHsv("#ff0000")).toEqual({ h: 0, s: 1, v: 1 });
    expect(hexToHsv("not-a-color")).toBe(null);

    for (const hex of ["#34c759", "#af52de", "#ff9500", "#007aff", "#123456"]) {
      expect(hsvToHex(hexToHsv(hex)!)).toBe(hex);
    }
  });
});
