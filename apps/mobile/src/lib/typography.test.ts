import { describe, expect, it } from "vite-plus/test";

import { MOBILE_CODE_SURFACE, MOBILE_TYPOGRAPHY } from "./typography";

describe("mobile typography", () => {
  it("uses the intentional compact mobile font scale", () => {
    expect(Object.values(MOBILE_TYPOGRAPHY).map(({ fontSize }) => fontSize)).toEqual([
      10, 11, 12, 13, 14, 15, 17, 20, 24, 28,
    ]);
  });

  it("uses a compact shared style for editable composer text", () => {
    expect(MOBILE_TYPOGRAPHY.composer).toEqual({ fontSize: 14, lineHeight: 20 });
  });

  it("uses caption-sized code with a compact readable row height", () => {
    expect(MOBILE_CODE_SURFACE).toMatchObject({
      fontSize: MOBILE_TYPOGRAPHY.caption.fontSize,
      lineNumberFontSize: MOBILE_TYPOGRAPHY.micro.fontSize,
      rowHeight: 20,
    });
  });
});
