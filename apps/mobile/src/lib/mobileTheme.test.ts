import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import {
  removeImportedMobileTheme,
  resolveColorSchemeOverride,
  resolveMobileThemePickerOptions,
  resolveMobileThemeColors,
  resolveMobileNativeSurfaceColors,
  resolveMobileThemePreferences,
  resolveMobileThemeVariables,
  withAlpha,
} from "./mobileTheme";
import { parseMobileThemeFile } from "./mobileThemeFile";

const GLOBAL_CSS = NodeFS.readFileSync(new URL("../../global.css", import.meta.url), "utf8");

function extractThemeVariables(appearance: "light" | "dark"): Readonly<Record<string, string>> {
  const variant = GLOBAL_CSS.match(
    new RegExp(`@variant\\s+${appearance}\\s*\\{([\\s\\S]*?)\\}`),
  )?.[1];
  if (!variant) throw new Error(`Missing ${appearance} theme block in global.css`);

  return Object.fromEntries(
    [...variant.matchAll(/(--color-[\w-]+)\s*:\s*([^;]+)\s*;/g)].map((match) => [
      match[1],
      match[2]?.trim(),
    ]),
  );
}

describe("mobile theme preferences", () => {
  it("defaults to the system appearance and T3 Code theme", () => {
    expect(resolveMobileThemePreferences(undefined)).toEqual({
      appearanceMode: "system",
      themeId: "t3-code",
    });
    expect(resolveMobileNativeSurfaceColors("t3-code", "light")).toBeNull();
    expect(resolveMobileNativeSurfaceColors("t3-code", "dark")).toBeNull();
  });

  it("drops unknown stored values", () => {
    expect(
      resolveMobileThemePreferences({ appearanceMode: "sepia", themeId: "custom-theme" }),
    ).toEqual({ appearanceMode: "system", themeId: "t3-code" });
  });

  it("retains a selected imported theme while it remains installed", () => {
    const imported = parseMobileThemeFile({
      version: 1,
      id: "northern-lights",
      name: "Northern Lights",
      appearance: "light",
      colors: { canvas: "#f1f5f9" },
    });

    expect(resolveMobileThemePreferences({ themeId: imported.id }, [imported])).toEqual({
      appearanceMode: "system",
      themeId: imported.id,
    });
  });

  it("falls back and persists cleanly when removing the selected imported theme", () => {
    const first = parseMobileThemeFile({
      version: 1,
      id: "first-theme",
      name: "First Theme",
      appearance: "light",
      colors: { canvas: "#f1f5f9" },
    });
    const second = parseMobileThemeFile({
      version: 1,
      id: "second-theme",
      name: "Second Theme",
      appearance: "dark",
      colors: { canvas: "#0f172a" },
    });

    expect(removeImportedMobileTheme([first, second], first.id, first.id)).toEqual({
      importedThemes: [second],
      themeId: "t3-code",
    });
    expect(removeImportedMobileTheme([first, second], first.id, second.id)).toEqual({
      importedThemes: [second],
    });
    expect(removeImportedMobileTheme([first, second], "not-installed", second.id)).toBeNull();
  });

  it("keeps built-ins first and preserves imported-theme order", () => {
    const first = parseMobileThemeFile({
      version: 1,
      id: "zebra-theme",
      name: "Zebra Theme",
      appearance: "light",
      colors: { canvas: "#ffffff" },
    });
    const second = parseMobileThemeFile({
      version: 1,
      id: "amber-theme",
      name: "Amber Theme",
      appearance: "dark",
      colors: { canvas: "#000000" },
    });
    const options = resolveMobileThemePickerOptions([first, second]);

    expect(options.map((option) => option.id)).toEqual([
      "t3-code",
      "t3-chat",
      "grove",
      "ocean",
      "ember",
      "iris",
      "zebra-theme",
      "amber-theme",
    ]);
    expect(resolveMobileThemePickerOptions([])[0]).toBe(options[0]);
  });
});

describe("mobile theme palette resolution", () => {
  it.each(["light", "dark"] as const)(
    "keeps the T3 Code %s palette identical to global.css",
    (appearance) => {
      expect(resolveMobileThemeVariables("t3-code", appearance)).toEqual(
        extractThemeVariables(appearance),
      );
    },
  );

  it("resolves the selected theme for each appearance", () => {
    expect(resolveMobileThemeColors("ocean", "light")).toMatchObject({
      canvas: "#f5f7f8",
      accent: "#2672af",
    });
    expect(resolveMobileThemeColors("ocean", "dark")).toMatchObject({
      canvas: "#17212b",
      accent: "#70b9ee",
    });
  });

  it("falls back to T3 Code for stale theme ids", () => {
    const flagship = resolveMobileThemeColors("t3-code", "light");

    expect(resolveMobileThemeColors("removed-theme", "light")).toEqual(flagship);
  });

  it("maps imported theme roles with per-appearance T3 Code fallbacks", () => {
    const imported = parseMobileThemeFile({
      version: 1,
      id: "northern-lights",
      name: "Northern Lights",
      appearance: "light",
      colors: {
        canvas: "#f1f5f9",
        text: "#0f172a",
        border: "#cbd5e1",
        accent: "#2563eb",
        terminalBackground: "#e2e8f0",
        terminalForeground: "#1e293b",
        terminalCursor: "#3b82f6",
      },
    });

    expect(resolveMobileThemeColors(imported.id, "light", [imported])).toMatchObject({
      canvas: "#f1f5f9",
      text: "#0f172a",
      border: "#cbd5e1",
      accent: "#2563eb",
      surface: "#ffffff",
    });
    expect(resolveMobileThemeColors(imported.id, "dark", [imported])).toEqual(
      resolveMobileThemeColors("t3-code", "dark"),
    );
    expect(resolveMobileNativeSurfaceColors(imported.id, "dark", [imported])).toBeNull();
    expect(resolveMobileNativeSurfaceColors(imported.id, "light", [imported])).toMatchObject({
      terminalBackground: "#e2e8f0",
      terminalForeground: "#1e293b",
      terminalCursor: "#3b82f6",
      sheetBackground: "#f1f5f9fa",
      foreground: "#0f172a",
      border: "#cbd5e1",
      accent: "#2563eb",
    });
  });

  it("resolves sparse imported roles with normalized T3 Code fallbacks", () => {
    const imported = parseMobileThemeFile({
      version: 1,
      id: "sparse-light",
      name: "Sparse Light",
      appearance: "light",
      colors: { canvas: "#f1f5f9" },
    });

    expect(resolveMobileThemeVariables(imported.id, "light", [imported])).toMatchObject({
      "--color-screen": "#f1f5f9",
      "--color-card": "#ffffff",
      "--color-border": "#00000014",
      "--color-md-code-bg": "#0000000a",
    });
  });

  it("returns the exact T3 Code variables for an absent imported appearance", () => {
    const imported = parseMobileThemeFile({
      version: 1,
      id: "light-only",
      name: "Light Only",
      appearance: "light",
      colors: resolveMobileThemeColors("ocean", "light"),
    });

    expect(resolveMobileThemeVariables(imported.id, "dark", [imported])).toBe(
      resolveMobileThemeVariables("t3-code", "dark"),
    );
  });

  it("maps core roles onto mobile CSS variables", () => {
    expect(resolveMobileThemeVariables("iris", "dark")).toMatchObject({
      "--color-screen": "#1d1929",
      "--color-primary": "#9d7df2",
      "--color-foreground": "#fffaff",
      "--color-user-bubble": "#4b3d72",
    });
  });

  it("uses alternate-theme surfaces for input fills and web input roles for borders", () => {
    expect(resolveMobileThemeVariables("iris", "dark")).toMatchObject({
      "--color-input": "#1d1929",
      "--color-input-border": "#5d527b",
    });
  });

  it("uses accent-derived inline-skill colors for alternate themes", () => {
    expect(resolveMobileThemeVariables("t3-chat", "light")).toMatchObject({
      "--color-inline-skill-background": "#db27771f",
      "--color-inline-skill-border": "#db277740",
      "--color-inline-skill-foreground": "#db2777",
    });
  });

  it("preserves the legacy T3 Code markdown palette", () => {
    expect(resolveMobileThemeVariables("t3-code", "light")).toMatchObject({
      "--color-md-body": "#111111",
      "--color-md-strong": "#000000",
      "--color-md-link": "#2563eb",
      "--color-md-blockquote-border": "rgba(0, 0, 0, 0.08)",
      "--color-md-blockquote-bg": "rgba(0, 0, 0, 0.02)",
      "--color-md-code-bg": "rgba(0, 0, 0, 0.04)",
      "--color-md-code-text": "#262626",
      "--color-md-inline-code-text": "#5f6368",
      "--color-md-user-code-bg": "rgba(255, 255, 255, 0.22)",
      "--color-md-user-code-text": "#ffffff",
      "--color-md-user-inline-code-text": "rgba(255, 255, 255, 0.82)",
      "--color-md-user-fence-bg": "rgba(0, 0, 0, 0.16)",
      "--color-md-user-fence-text": "#ffffff",
      "--color-md-hr": "rgba(0, 0, 0, 0.08)",
      "--color-user-bubble": "#007aff",
      "--color-user-bubble-foreground": "#ffffff",
      "--color-user-bubble-foreground-muted": "rgba(255, 255, 255, 0.78)",
    });

    expect(resolveMobileThemeVariables("t3-code", "dark")).toMatchObject({
      "--color-md-body": "#e5e5e5",
      "--color-md-strong": "#f5f5f5",
      "--color-md-link": "#60a5fa",
      "--color-md-blockquote-border": "rgba(255, 255, 255, 0.1)",
      "--color-md-blockquote-bg": "rgba(255, 255, 255, 0.03)",
      "--color-md-code-bg": "rgba(255, 255, 255, 0.06)",
      "--color-md-code-text": "#e5e5e5",
      "--color-md-inline-code-text": "#b8bcc2",
      "--color-md-user-code-bg": "rgba(255, 255, 255, 0.18)",
      "--color-md-user-code-text": "#ffffff",
      "--color-md-user-inline-code-text": "rgba(255, 255, 255, 0.82)",
      "--color-md-user-fence-bg": "rgba(0, 0, 0, 0.28)",
      "--color-md-user-fence-text": "#ffffff",
      "--color-md-hr": "rgba(255, 255, 255, 0.08)",
      "--color-user-bubble": "#0a84ff",
      "--color-user-bubble-foreground": "#ffffff",
      "--color-user-bubble-foreground-muted": "rgba(255, 255, 255, 0.78)",
    });
  });

  it("uses readable role tokens for T3 Chat light markdown", () => {
    expect(resolveMobileThemeVariables("t3-chat", "light")).toMatchObject({
      "--color-md-body": "#501854",
      "--color-md-strong": "#501854",
      "--color-md-link": "#db2777",
      "--color-md-inline-code-text": "#ac1668",
      "--color-md-user-inline-code-text": "#492c61d1",
      "--color-user-bubble": "#f7def2",
      "--color-user-bubble-foreground": "#492c61",
      "--color-user-bubble-foreground-muted": "#492c61c7",
    });
  });
});

describe("mobile theme color helpers", () => {
  it("rejects colors that cannot accept a hex alpha suffix", () => {
    expect(() => withAlpha("rgb(0, 0, 0)", "1f")).toThrow(/6- or 8-digit hex/i);
  });

  it("replaces an existing hex alpha for imported colors", () => {
    expect(withAlpha("#11223380", "1f")).toBe("#1122331f");
  });
});

describe("mobile appearance mode override", () => {
  it("derives native overrides while leaving system mode adaptive", () => {
    expect(resolveColorSchemeOverride("system")).toBeNull();
    expect(resolveColorSchemeOverride("light")).toBe("light");
    expect(resolveColorSchemeOverride("dark")).toBe("dark");
  });
});
