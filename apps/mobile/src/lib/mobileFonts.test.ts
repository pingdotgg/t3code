import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_FONT_SELECTIONS,
  normalizeFontSelections,
  resolveMobileFonts,
} from "./mobileFonts";

const serif = {
  name: "ExampleSerif-Regular",
  label: "Example Serif",
  regular: "ExampleSerif-Regular",
  medium: "ExampleSerif-Medium",
  bold: "ExampleSerif-Bold",
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
