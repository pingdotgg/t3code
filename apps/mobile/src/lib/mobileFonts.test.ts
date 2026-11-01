import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_FONT_SELECTIONS,
  normalizeFontSelections,
  reconcileInstalledFonts,
  normalizeReplyEmphasisWeights,
  resolveReplyEmphasis,
  resolveMobileFonts,
} from "./mobileFonts";

const serif = {
  name: "ExampleSerif-Regular",
  label: "Example Serif",
  regular: "ExampleSerif-Regular",
  medium: "ExampleSerif-Medium",
  bold: "ExampleSerif-Bold",
  emphasisFaces: {
    "500": "ExampleSerif-Medium",
    "600": "ExampleSerif-Semibold",
    "700": "ExampleSerif-Bold",
  },
};

describe("installed mobile fonts", () => {
  it("preserves installed font names and resets removed import choices and invalid preferences", () => {
    expect(
      normalizeFontSelections({
        interface: "serif",
        reply: "installed:ExampleSerif-Regular",
        composer: "imported:Old Family",
        code: "installed:",
      }),
    ).toEqual({
      interface: "serif",
      reply: "installed:ExampleSerif-Regular",
      composer: "",
      code: "",
    });
    expect(
      normalizeFontSelections({ reply: 42, interface: "installed:" + "x".repeat(251) }),
    ).toEqual(DEFAULT_FONT_SELECTIONS);
  });

  it("uses the selected family's native weight faces independently for each role", () => {
    const fonts = resolveMobileFonts(
      {
        ...DEFAULT_FONT_SELECTIONS,
        interface: "serif",
        reply: `installed:${serif.name}`,
        code: "monospace",
      },
      new Map([[serif.name, serif]]),
      "ios",
    );
    expect(fonts.interface.regular).toBe("Georgia");
    expect(fonts.composer).toEqual(fonts.interface);
    expect(fonts.reply).toMatchObject({
      regular: serif.regular,
      medium: serif.medium,
      bold: serif.bold,
    });
    expect(fonts.code.regular).toBe("Menlo-Regular");
  });

  it("falls back while resolving or after an installed font is removed", () => {
    const fonts = resolveMobileFonts(
      { ...DEFAULT_FONT_SELECTIONS, reply: `installed:${serif.name}` },
      new Map(),
      "ios",
    );
    expect(fonts.reply).toEqual(fonts.interface);
  });

  it("keeps Android's system family choices without a file import dependency", () => {
    const fonts = resolveMobileFonts(
      { interface: "system", reply: "serif", composer: "monospace", code: "" },
      new Map(),
      "android",
    );
    expect(fonts.interface.regular).toBe("sans-serif");
    expect(fonts.reply.regular).toBe("serif");
    expect(fonts.composer.regular).toBe("monospace");
    expect(fonts.code.regular).toBe("monospace");
  });
});

describe("reply emphasis", () => {
  it("preserves the default bold face and only changes emphasis for a selected weight", () => {
    const standard = resolveMobileFonts(DEFAULT_FONT_SELECTIONS, new Map(), "ios");
    expect(resolveReplyEmphasis(standard.reply)).toBe("DMSans-Bold");
    expect(resolveReplyEmphasis(standard.reply, "500")).toBe("DMSans-Medium");
  });

  it("selects a real installed semibold face and falls back when that weight is unavailable", () => {
    expect(resolveReplyEmphasis(serif, "600")).toBe("ExampleSerif-Semibold");
    expect(
      resolveReplyEmphasis(
        {
          regular: "Example-Regular",
          medium: "Example-Regular",
          bold: "Example-Bold",
          emphasisFaces: { "700": "Example-Bold" },
        },
        "600",
      ),
    ).toBe("Example-Bold");
  });

  it("remembers different weights per font and drops invalid saved values", () => {
    const saved = normalizeReplyEmphasisWeights({
      "FirstSerif-Regular": "700",
      "SecondSerif-Regular": "600",
      invalid: 600,
      bad: "900",
      "": "500",
    });
    expect(saved).toEqual({ "FirstSerif-Regular": "700", "SecondSerif-Regular": "600" });
    expect(normalizeReplyEmphasisWeights(null)).toEqual({});
    expect(resolveReplyEmphasis(serif, saved["SecondSerif-Regular"])).toBe("ExampleSerif-Semibold");
  });
});

describe("font refresh identity", () => {
  it("keeps the map and font references when native descriptors are unchanged or reordered", () => {
    const second = { ...serif, name: "Other-Regular", regular: "Other-Regular" };
    const current = new Map([
      [serif.name, serif],
      [second.name, second],
    ]);
    const refreshed = new Map([
      [second.name, { ...second }],
      [serif.name, { ...serif, emphasisFaces: { ...serif.emphasisFaces } }],
    ]);
    expect(reconcileInstalledFonts(current, refreshed)).toBe(current);
  });

  it("applies changed faces and removals while keeping unrelated font references", () => {
    const second = { ...serif, name: "Other-Regular", regular: "Other-Regular" };
    const current = new Map([
      [serif.name, serif],
      [second.name, second],
    ]);
    const changed = {
      ...serif,
      emphasisFaces: { ...serif.emphasisFaces, "600": "Replacement-Semibold" },
    };
    const next = reconcileInstalledFonts(
      current,
      new Map([
        [serif.name, changed],
        [second.name, { ...second }],
      ]),
    );
    expect(next).not.toBe(current);
    expect(next.get(serif.name)?.emphasisFaces?.["600"]).toBe("Replacement-Semibold");
    expect(next.get(second.name)).toBe(second);
    expect(current.get(serif.name)?.emphasisFaces?.["600"]).toBe("ExampleSerif-Semibold");
    const removed = reconcileInstalledFonts(next, new Map([[second.name, second]]));
    expect(removed.has(serif.name)).toBe(false);
    const empty = reconcileInstalledFonts(removed, new Map());
    expect(empty.size).toBe(0);
    expect(reconcileInstalledFonts(empty, new Map())).toBe(empty);
  });

  it.each(["ios", "android"])(
    "reuses built-in family objects across unrelated %s font refreshes",
    (platform) => {
      const selections = {
        interface: "system",
        reply: "serif",
        composer: "monospace",
        code: "monospace",
      };
      const before = resolveMobileFonts(selections, new Map(), platform);
      const after = resolveMobileFonts(selections, new Map([[serif.name, serif]]), platform);
      for (const role of ["interface", "reply", "composer", "code"] as const)
        expect(after[role]).toBe(before[role]);
    },
  );
});
