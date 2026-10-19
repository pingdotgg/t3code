import { fontFixture } from "./mobileFonts.test-fixtures";
import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_FONT_SELECTIONS,
  importedFontVariant,
  mergeImportedFonts,
  normalizeFontSelections,
  normalizeImportedFonts,
  readFontMetadata,
  resolveMobileFonts,
  type ImportedFontFace,
} from "./mobileFonts";

const regular: ImportedFontFace = {
  id: "00000000-0000-4000-8000-000000000001",
  file: "00000000-0000-4000-8000-000000000001.ttf",
  family: "Example Serif",
  weight: 400,
  italic: false,
};
const italic: ImportedFontFace = {
  ...regular,
  id: "00000000-0000-4000-8000-000000000002",
  file: "00000000-0000-4000-8000-000000000002.ttf",
  italic: true,
};
const bold: ImportedFontFace = {
  ...regular,
  id: "00000000-0000-4000-8000-000000000003",
  file: "00000000-0000-4000-8000-000000000003.ttf",
  weight: 700,
};
const foreign: ImportedFontFace = {
  ...regular,
  id: "00000000-0000-4000-8000-000000000004",
  file: "00000000-0000-4000-8000-000000000004.ttf",
  family: "Other Sans",
  weight: 500,
};

describe("custom mobile font metadata", () => {
  it("groups styles by the Unicode typographic family, not legacy names or filenames", () => {
    expect(
      readFontMetadata(
        fontFixture({
          family: "Legacy Bold",
          typographicFamily: "École Serif",
          weight: 600,
          italic: true,
        }),
      ),
    ).toEqual({ family: "École Serif", weight: 600, italic: true });
  });
  it("falls back to the legacy family for static faces without typographic names", () => {
    expect(readFontMetadata(fontFixture())).toEqual({
      family: "Legacy Family",
      weight: 400,
      italic: false,
    });
  });
  it("explains unsupported variable files before they can be imported", () => {
    expect(() => readFontMetadata(fontFixture({ variable: true }))).toThrow("static font faces");
  });
  it("rejects truncated headers and out-of-range name strings", () => {
    expect(() => readFontMetadata(new Uint8Array(4))).toThrow("incomplete");
    const data = fontFixture();
    new DataView(data.buffer).setUint16(12 + 2 * 16 + 6 + 10, 65535);
    expect(() => readFontMetadata(data)).toThrow("name table");
  });
});

describe("custom mobile font choices", () => {
  it("does not inherit invalid choices or unsafe stored file paths", () => {
    expect(
      normalizeFontSelections({
        interface: "serif",
        reply: 42,
        composer: "unknown",
        code: "imported:Example Serif",
      }),
    ).toEqual({ interface: "serif", reply: "", composer: "", code: "imported:Example Serif" });
    expect(
      normalizeImportedFonts([
        regular,
        regular,
        { ...italic, file: "../private.ttf" },
        { ...bold, weight: Infinity },
      ]),
    ).toEqual([regular]);
  });
  it("replaces only the matching face when reimporting a weight and style", () => {
    const replacement = {
      ...regular,
      id: "00000000-0000-4000-8000-000000000005",
      file: "00000000-0000-4000-8000-000000000005.ttf",
    };
    expect(mergeImportedFonts([regular, italic, bold, foreign], [replacement])).toEqual([
      replacement,
      italic,
      bold,
      foreign,
    ]);
  });
  it("keeps italic companions and selects the requested weight within its family", () => {
    const faces = [foreign, bold, italic, regular];
    expect(importedFontVariant(faces, regular.family, 400)?.faces).toEqual([regular, italic]);
    expect(importedFontVariant(faces, regular.family, 700)?.faces).toEqual([bold]);
    expect(importedFontVariant(faces, regular.family, 500)?.faces).toEqual([regular, italic]);
  });
  it("does not reuse a loaded alias after an italic companion is removed", () => {
    const first = importedFontVariant([regular, italic], regular.family, 400)!;
    const after = importedFontVariant([regular], regular.family, 400)!;
    expect(after.alias).not.toBe(first.alias);
  });
  it("preserves interface inheritance and independent reply, composer, and code choices", () => {
    const faces = [regular, italic, bold, foreign];
    const loaded = new Set(
      [400, 500, 700].map((weight) => importedFontVariant(faces, regular.family, weight)!.alias),
    );
    const resolved = resolveMobileFonts(
      {
        ...DEFAULT_FONT_SELECTIONS,
        interface: "serif",
        reply: `imported:${regular.family}`,
        code: "monospace",
      },
      faces,
      loaded,
      "ios",
    );
    expect(resolved.interface.regular).toBe("Georgia");
    expect(resolved.composer).toEqual(resolved.interface);
    expect(resolved.reply.regular).toBe(importedFontVariant(faces, regular.family, 400)!.alias);
    expect(resolved.reply.bold).toBe(importedFontVariant(faces, regular.family, 700)!.alias);
    expect(resolved.code.regular).toBe("Menlo-Regular");
  });
  it("uses defaults while a font is unavailable and after it is removed", () => {
    const choice = { ...DEFAULT_FONT_SELECTIONS, reply: `imported:${regular.family}` };
    const pending = resolveMobileFonts(choice, [regular], new Set(), "android");
    expect(pending.reply).toEqual(pending.interface);
    const removed = resolveMobileFonts(
      choice,
      [],
      new Set([importedFontVariant([regular], regular.family, 400)!.alias]),
      "android",
    );
    expect(removed.reply).toEqual(removed.interface);
  });
});
