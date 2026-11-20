import { describe, expect, it } from "vite-plus/test";
import { getMobileReplyTypography, getMobileUserTypography } from "./typography";
import { getMobileFontFamilies, FONT_FAMILIES } from "./fontFamilies";

describe("theme typography", () => {
  it("uses the bundled sans, serif, and code families for Absolutely", () => {
    expect(getMobileFontFamilies("absolutely")).toEqual({
      regular: "DMSans-Regular",
      medium: "DMSans-Medium",
      bold: "DMSans-Bold",
      code: "JetBrainsMono-Regular",
    });
    expect(getMobileReplyTypography("absolutely")).toEqual({
      fontSize: 15,
      lineHeight: 22,
      codeBlockFontSize: 14,
      codeBlockLineHeight: 22.75,
      headingLineHeightMultiplier: 1.25,
      headingFontSizes: [26.25, 20.625, 16.875, 15, 13.125, 13.125],
      fontFamily: "SourceSerif4-Regular",
      headingFontFamily: "SourceSerif4-Semibold",
      boldFontFamily: "SourceSerif4-Semibold",
    });
  });

  it("scales measured message sizes with the mobile text preference", () => {
    expect(getMobileReplyTypography("absolutely", 20)?.fontSize).toBe(18.75);
    expect(getMobileReplyTypography("absolutely", 20)?.lineHeight).toBe(27.5);
    expect(getMobileUserTypography("absolutely")).toMatchObject({ fontSize: 15, lineHeight: 20 });
  });

  it("returns to the existing fonts with other themes", () => {
    for (const theme of ["t3-code", "grove"]) {
      expect(getMobileFontFamilies(theme)).toBe(FONT_FAMILIES);
      expect(getMobileReplyTypography(theme)).toBeNull();
    }
  });
});
