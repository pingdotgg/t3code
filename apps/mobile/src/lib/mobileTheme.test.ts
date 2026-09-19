import { describe, expect, it } from "vite-plus/test";
import {
  BUILT_IN_THEME_IDS,
  BUILT_IN_THEMES,
  T3_CHAT_THEME,
  T3_CODE_LIGHT_THEME_COLORS,
  T3_CODE_DARK_THEME_COLORS,
  MOBILE_THEME_IDS,
  getThemeColorsForAppearance,
} from "@t3tools/shared/themePalettes";
import { readDefaultMobileThemeVariables } from "./mobileTheme.test-support";

import {
  createMobileThemePairPatch,
  createMobileThemeSelectionPatch,
  createMobileThemeVariables,
  DEFAULT_MOBILE_THEME_ID,
  flattenThemeColor,
  getMobileThemePreviewColors,
  getMobileThemeVariables,
  normalizeMobileThemeId,
  normalizeMobileThemeMode,
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
    const generatedVariables = createMobileThemeVariables(T3_CHAT_THEME.colors, "light");
    expect(Object.keys(readDefaultMobileThemeVariables("light")).sort()).toEqual(
      Object.keys(generatedVariables).sort(),
    );
    expect(Object.keys(readDefaultMobileThemeVariables("dark")).sort()).toEqual(
      Object.keys(generatedVariables).sort(),
    );
  });

  it("shares all built-in desktop palettes", () => {
    expect(BUILT_IN_THEMES.map((theme) => theme.id)).toEqual(BUILT_IN_THEME_IDS);
    for (const themeId of BUILT_IN_THEME_IDS) {
      expect(getMobileThemeVariables(themeId, "light")["--color-screen"]).toMatch(/^#/);
      expect(getMobileThemeVariables(themeId, "dark")["--color-screen"]).toMatch(/^#/);
    }
  });

  it.each(MOBILE_THEME_IDS)("uses the web color roles for %s in both appearances", (themeId) => {
    for (const appearance of ["light", "dark"] as const) {
      const theme = BUILT_IN_THEMES.find((candidate) => candidate.id === themeId);
      const colors = theme
        ? getThemeColorsForAppearance(theme, appearance)!
        : appearance === "dark"
          ? T3_CODE_DARK_THEME_COLORS
          : T3_CODE_LIGHT_THEME_COLORS;
      const variables =
        themeId === DEFAULT_MOBILE_THEME_ID
          ? readDefaultMobileThemeVariables(appearance)
          : getMobileThemeVariables(themeId, appearance);
      expect(variables["--color-screen"]).toBe(themeColorToNativeColor(colors.canvas));
      expect(variables["--color-thread-canvas"]).toBe(variables["--color-screen"]);
      expect(variables["--color-drawer"]).toBe(themeColorToNativeColor(colors.sidebar));
      expect(variables["--color-thread-hover"]).toBe(
        themeColorToNativeColor(colors.sidebarRowHover),
      );
      expect(variables["--color-card"]).toBe(themeColorToNativeColor(colors.surface));
      expect(variables["--color-composer-surface"]).toBe(
        themeColorWithAlpha(
          themeId === DEFAULT_MOBILE_THEME_ID
            ? variables["--color-grouped-card"]
            : themeColorToNativeColor(colors.surface),
          appearance === "dark" ? 0.9 : 0.94,
        ),
      );
      expect(variables["--color-thread-selected"]).toBe(
        themeColorToNativeColor(colors.sidebarRowActive),
      );
      expect(variables["--color-thread-selected-foreground"]).toBe(
        themeColorToNativeColor(colors.sidebarForeground),
      );
      expect(variables["--color-primary"]).toBe(themeColorToNativeColor(colors.messageAction));
      if (themeId !== DEFAULT_MOBILE_THEME_ID) {
        expect(variables["--color-user-bubble"]).toBe(
          themeColorToNativeColor(colors.messageSurface),
        );
      }
      expect(
        contrastRatio(variables["--color-foreground"], variables["--color-screen"]),
      ).toBeGreaterThanOrEqual(4.5);
      for (const [foreground, surface] of [
        ["--color-drawer-foreground", "--color-drawer"],
        ["--color-drawer-foreground-muted", "--color-drawer"],
        ["--color-drawer-foreground", "--color-thread-hover"],
        ["--color-primary-foreground", "--color-primary"],
        ["--color-primary-text", "--color-screen"],
        ["--color-primary-text", "--color-card"],
        ["--color-primary-text", "--color-card-alt"],
        ["--color-primary-text", "--color-sheet-solid"],
        ["--color-primary-text", "--color-grouped-card"],
        ["--color-foreground", "--color-grouped-card"],
        ["--color-foreground-muted", "--color-grouped-card"],
        ["--color-placeholder", "--color-grouped-card"],
        ["--color-secondary-foreground", "--color-secondary"],
        ["--color-user-bubble-foreground", "--color-user-bubble"],
        ["--color-warning-foreground", "--color-warning"],
        ["--color-danger-foreground", "--color-danger"],
        ["--color-md-body", "--color-screen"],
        ["--color-md-strong", "--color-screen"],
        ["--color-md-link", "--color-screen"],
        ["--color-md-code-text", "--color-md-code-bg"],
      ] as const) {
        expect(
          contrastRatio(variables[foreground], variables[surface]),
          `${appearance}: ${foreground} on ${surface}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
      expect(
        contrastRatio(
          variables["--color-thread-selected-foreground"],
          variables["--color-thread-selected"],
        ),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("applies palette overrides on top of the selected built-in theme", () => {
    const variables = getMobileThemeVariables("ocean", "dark", {
      "--color-primary": "#123456",
    });

    expect(variables["--color-primary"]).toBe("#123456");
    expect(variables["--color-screen"]).toMatch(/^#/);
  });

  it.each(["light", "dark"] as const)(
    "separates default settings groups from their %s background",
    (appearance) => {
      const variables = getMobileThemeVariables("t3-code", appearance);
      expect(
        contrastRatio(variables["--color-grouped-card"], variables["--color-sheet-solid"]),
      ).toBeGreaterThanOrEqual(1.06);
      expect(variables["--color-grouped-card"]).not.toBe(variables["--color-card"]);
    },
  );

  it.each(["light", "dark"] as const)(
    "slightly strengthens default %s messages and separates fallback materials",
    (appearance) => {
      const variables = getMobileThemeVariables("t3-code", appearance);
      const desktop =
        appearance === "dark" ? T3_CODE_DARK_THEME_COLORS : T3_CODE_LIGHT_THEME_COLORS;
      const bubbleContrast = contrastRatio(
        variables["--color-user-bubble"],
        variables["--color-screen"],
      );
      expect(bubbleContrast).toBeGreaterThan(contrastRatio(desktop.messageSurface, desktop.canvas));
      expect(bubbleContrast).toBeLessThan(1.2);
      for (const role of ["--color-composer-surface", "--color-glass-fallback"] as const) {
        const surface = flattenThemeColor(variables[role], variables["--color-screen"]);
        expect(contrastRatio(surface, variables["--color-screen"])).toBeGreaterThanOrEqual(1.06);
        for (const foreground of [
          "--color-foreground",
          "--color-placeholder",
          "--color-primary-text",
        ] as const) {
          expect(contrastRatio(variables[foreground], surface)).toBeGreaterThanOrEqual(4.5);
        }
      }
    },
  );

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
    const variables = createMobileThemeVariables(T3_CHAT_THEME.colors, "light");
    expect(variables["--color-sheet-solid"]).toBe(
      themeColorToNativeColor(T3_CHAT_THEME.colors.chrome),
    );
    expect(variables["--color-warning"]).toBe(
      themeColorToNativeColor(T3_CHAT_THEME.colors.warningSurface),
    );
    expect(variables["--color-warning-foreground"]).toBe(
      themeColorToNativeColor(T3_CHAT_THEME.colors.warningForeground),
    );
    expect(variables["--color-primary"]).not.toBe(variables["--color-screen"]);
    expect(variables["--color-primary-shadow"]).toBe("#000000");
    expect(variables["--color-backdrop"]).toBe("rgba(0, 0, 0, 0.22)");
    expect(variables["--color-drawer-shadow"]).toBe("rgba(0, 0, 0, 0.12)");
    expect(variables["--color-user-bubble-foreground"]).toMatch(/^#/);
  });

  it("keeps every built-in shadow and backdrop black-based in dark mode", () => {
    for (const themeId of BUILT_IN_THEME_IDS) {
      const variables = getMobileThemeVariables(themeId, "dark");
      expect(variables["--color-primary-shadow"]).toBe("#000000");
      expect(variables["--color-backdrop"]).toBe("rgba(0, 0, 0, 0.48)");
      expect(variables["--color-drawer-shadow"]).toBe("rgba(0, 0, 0, 0.32)");
    }
  });

  it("keeps placeholders and selected-row labels readable on their mobile surfaces", () => {
    for (const themeId of BUILT_IN_THEME_IDS) {
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

  it("keeps the default user bubble readable in both appearances", () => {
    for (const appearance of ["light", "dark"] as const) {
      const variables = readDefaultMobileThemeVariables(appearance);
      const bubble = variables["--color-user-bubble"];
      expect(
        contrastRatio(variables["--color-user-bubble-foreground"], bubble),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(variables["--color-user-bubble-skill-foreground"], bubble),
      ).toBeGreaterThanOrEqual(4.5);
      expect(variables["--color-user-bubble-skill-foreground"]).not.toBe(
        variables["--color-user-bubble-foreground"],
      );
      const fenceSurface = compositeOver(variables["--color-md-user-fence-bg"], bubble);
      expect(fenceSurface).not.toBe(bubble);
      expect(
        contrastRatio(variables["--color-md-user-fence-text"], fenceSurface),
      ).toBeGreaterThanOrEqual(4.5);
      const codeSurface = compositeOver(variables["--color-md-user-code-bg"], bubble);
      expect(
        contrastRatio(variables["--color-md-user-code-text"], codeSurface),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("flattenThemeColor", () => {
  it("composites a translucent border over its surface", async () => {
    const { flattenThemeColor } = await import("./mobileTheme");
    // `--color-border` in the dark theme, over the surface a chip sits on. Native chip drawing
    // parses opaque hex only, so this has to resolve before it crosses the bridge.
    expect(flattenThemeColor("rgba(255, 255, 255, 0.06)", "#171717")).toBe("#252525");
    expect(flattenThemeColor("rgba(0, 0, 0, 0.08)", "#ffffff")).toBe("#ebebeb");
  });

  it("leaves an already opaque colour alone", async () => {
    const { flattenThemeColor } = await import("./mobileTheme");
    expect(flattenThemeColor("#171717", "#ffffff")).toBe("#171717");
  });

  it("treats a colour with no alpha as fully opaque", async () => {
    const { flattenThemeColor } = await import("./mobileTheme");
    expect(flattenThemeColor("rgb(255, 0, 0)", "#000000")).toBe("#ff0000");
  });
});
