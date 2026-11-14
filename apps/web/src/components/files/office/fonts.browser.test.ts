import { BUNDLED_FONTS } from "@betteroffice/fonts";
import { describe, expect, it } from "vite-plus/test";
import { sheetFace, wordFonts } from "./fonts";

const notoSansJp = BUNDLED_FONTS.find((face) => face.file === "NotoSansJP-Regular.otf")!;
const fonts = wordFonts();

describe("wordFonts", () => {
  it.each([
    ["Yu Gothic", fonts.resolve("Yu Gothic", false, false)],
    ["MS Gothic", fonts.resolve("MS Gothic", false, false)],
    ["the Japanese fallback", fonts.resolveScriptFallback?.("cjk-jp", false, false)],
  ])("draws %s with Noto Sans JP", async (_, load) => {
    const bytes = await load?.();

    expect(bytes?.byteLength).toBe(notoSansJp.byteLength);
  });
});

it.each([false, true])(
  "uses the available Comic Relief face for italic spreadsheet text (bold: %s)",
  (bold) => {
    expect(sheetFace("Comic Relief", bold, true)).toMatchObject({
      family: "Comic Relief",
      weight: bold ? 700 : 400,
      style: "normal",
    });
  },
);
