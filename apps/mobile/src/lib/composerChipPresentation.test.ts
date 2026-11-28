import { decodeOptions } from "gt-react-native";
import { describe, expect, it } from "vite-plus/test";

import type { MessageResolver } from "../i18n/messages";

import {
  composerChipSizeSuffix,
  contextChipAccent,
  contextChipPresentation,
} from "./composerChipPresentation";
import {
  flattenThemeColor,
  getMobileThemeVariables,
  MOBILE_THEME_IDS,
  type MobileThemeVariables,
} from "./mobileTheme";

describe("composerChipSizeSuffix", () => {
  it("shows a file chip's size in the app language", () => {
    const french = ((message: string, options?: Record<string, unknown>) => {
      const vars = { ...decodeOptions(message), ...options };
      const units: Record<string, string> = { "{size} KB": "{size} Ko", "{size} MB": "{size} Mo" };
      return (units[String(vars.$_source)] ?? String(vars.$_source)).replace(
        "{size}",
        String(vars.size),
      );
    }) as MessageResolver;
    expect(composerChipSizeSuffix({ kind: "file", sizeBytes: 12 * 1024 }, french)).toBe("12 Ko");
    expect(composerChipSizeSuffix({ kind: "image", sizeBytes: 3 * 1024 * 1024 }, french)).toBe(
      "3.0 Mo",
    );
  });
});

const CHIP_ACCENTS = [
  ...new Set(
    [
      ...[
        "image",
        "video",
        "file",
        "mention",
        "terminal",
        "element",
        "review-comment",
        "pull-request",
        "skill",
        "thread",
        "environment",
      ].map((kind) => contextChipPresentation(kind)),
      ...[
        { state: "open", isDraft: false },
        { state: "open", isDraft: true },
        { state: "merged", isDraft: false },
        { state: "closed", isDraft: false },
      ].map((pullRequest) => contextChipPresentation("pull-request", { pullRequest })),
    ].flatMap(({ accent }) => (accent ? [accent] : [])),
  ),
];

function relativeLuminance(hex: string): number {
  const [red = 0, green = 0, blue = 0] = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(first: string, second: string): number {
  const [darker = 0, lighter = 0] = [relativeLuminance(first), relativeLuminance(second)].sort(
    (a, b) => a - b,
  );
  return (lighter + 0.05) / (darker + 0.05);
}

function chipSurfaces(theme: MobileThemeVariables) {
  const screen = theme["--color-screen"];
  return (
    [
      ["--color-user-bubble", "--color-user-bubble-foreground"],
      ["--color-thread-canvas", "--color-md-body"],
      ["--color-composer-surface", "--color-foreground"],
    ] as const
  ).map(([surface, text]) => ({
    surface: flattenThemeColor(theme[surface], screen).slice(0, 7),
    text: theme[text],
  }));
}

const BUILT_IN_THEMES = MOBILE_THEME_IDS.filter((id) => id !== "material-you").flatMap((id) =>
  (["light", "dark"] as const).map((appearance) => ({
    name: `${id} ${appearance}`,
    theme: getMobileThemeVariables(id, appearance),
  })),
);

describe("contextChipAccent", () => {
  it("draws one color per theme that reads at 5:1 in messages, replies and the composer", () => {
    for (const { name, theme } of BUILT_IN_THEMES) {
      for (const accent of CHIP_ACCENTS) {
        const shown = contextChipAccent(accent, theme, theme["--color-md-body"])!;
        for (const { surface, text } of chipSurfaces(theme)) {
          expect(contextChipAccent(accent, theme, text)).toBe(shown);
          expect(
            contrastRatio(shown, surface),
            `${name}: ${accent} → ${shown} on ${surface}`,
          ).toBeGreaterThanOrEqual(5);
        }
      }
    }
  });

  it("reads on both a saturated Material You bubble and the light canvas beside it", () => {
    const theme = {
      ...getMobileThemeVariables("t3-code", "light"),
      "--color-user-bubble": "#6750a4",
      "--color-user-bubble-foreground": "#ffffff",
    };
    for (const { surface, text } of chipSurfaces(theme)) {
      for (const accent of CHIP_ACCENTS) {
        const shown = contextChipAccent(accent, theme, text)!;
        expect(
          contrastRatio(shown, surface),
          `${accent} → ${shown} on ${surface}`,
        ).toBeGreaterThanOrEqual(5);
      }
    }
  });

  it("keeps an accent that already reads everywhere", () => {
    const theme = getMobileThemeVariables("t3-code", "dark");
    expect(contextChipAccent("#00b080", theme, theme["--color-md-body"])).toBe("#00b080");
  });
});

describe("contextChipPresentation", () => {
  it("draws a mentioned machine as a machine, not the generic file chip", () => {
    expect(contextChipPresentation("environment")).toEqual({ accent: "#3f9a4f", icon: "server" });
  });
});
