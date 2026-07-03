import { describe, expect, it } from "vite-plus/test";

import { MOBILE_CODE_SURFACE, MOBILE_TYPOGRAPHY } from "./typography";

describe("mobile typography", () => {
  it("uses the intentional mobile font scale anchored at a 16pt body", () => {
    expect(Object.values(MOBILE_TYPOGRAPHY).map(({ fontSize }) => fontSize)).toEqual([
      11, 12, 13, 14, 16, 18, 21, 26, 30,
    ]);
    expect(MOBILE_TYPOGRAPHY.body).toEqual({ fontSize: 16, lineHeight: 23 });
  });

  it("uses caption-sized code with a compact readable row height", () => {
    expect(MOBILE_CODE_SURFACE).toMatchObject({
      fontSize: MOBILE_TYPOGRAPHY.caption.fontSize,
      lineNumberFontSize: MOBILE_TYPOGRAPHY.micro.fontSize,
      rowHeight: 22,
    });
  });
});
