import type { ThemeRegistrationResolved } from "@pierre/diffs";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { registerCustomTheme } = vi.hoisted(() => ({
  registerCustomTheme: vi.fn(),
}));

vi.mock("@pierre/diffs", () => ({ registerCustomTheme }));

import { activateSyntaxTheme } from "./syntaxTheme";

const syntax = {
  tokenColors: [
    {
      name: "Comments",
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "#6e6a86", fontStyle: "italic" },
    },
  ],
};

describe("syntax theme resolution", () => {
  beforeEach(() => {
    registerCustomTheme.mockClear();
  });

  it("uses the bundled fallback when the active app theme has no syntax rules", () => {
    expect(
      activateSyntaxTheme({
        appearance: "dark",
        background: "#191724",
        foreground: "#e0def4",
      }),
    ).toBe("pierre-dark");
    expect(registerCustomTheme).not.toHaveBeenCalled();
  });

  it("registers stable content-addressed Shiki themes", async () => {
    const input = {
      appearance: "dark" as const,
      background: "#191724",
      foreground: "#e0def4",
      label: "Rosé Pine",
      syntax,
    };
    const first = activateSyntaxTheme(input);
    const second = activateSyntaxTheme({ ...input, label: "Renamed" });

    expect(first).toBe(second);
    expect(first).toMatch(/^t3-syntax-v1-dark-[\da-f]{64}$/);
    expect(registerCustomTheme).toHaveBeenCalledTimes(1);

    const loader = registerCustomTheme.mock
      .calls[0]![1] as () => Promise<ThemeRegistrationResolved>;
    await expect(loader()).resolves.toMatchObject({
      name: first,
      displayName: "Rosé Pine",
      type: "dark",
      bg: "#191724",
      fg: "#e0def4",
      settings: syntax.tokenColors,
      tokenColors: syntax.tokenColors,
    });
  });

  it("registers empty token colors instead of restoring Pierre rules", async () => {
    const name = activateSyntaxTheme({
      appearance: "light",
      background: "#faf4ed",
      foreground: "#575279",
      syntax: { tokenColors: [] },
    });

    expect(name).toMatch(/^t3-syntax-v1-light-[\da-f]{64}$/);
    const loader = registerCustomTheme.mock
      .calls[0]![1] as () => Promise<ThemeRegistrationResolved>;
    await expect(loader()).resolves.toMatchObject({ settings: [], tokenColors: [] });
  });

  it("uses a new registration when token colors change", () => {
    const first = activateSyntaxTheme({
      appearance: "dark",
      background: "#1a1725",
      foreground: "#e0def4",
      syntax,
    });
    const second = activateSyntaxTheme({
      appearance: "dark",
      background: "#1a1725",
      foreground: "#e0def4",
      syntax: {
        tokenColors: [
          { scope: "comment", settings: { foreground: "#908caa", fontStyle: "italic" } },
        ],
      },
    });

    expect(second).not.toBe(first);
    expect(registerCustomTheme).toHaveBeenCalledTimes(2);
  });
});
