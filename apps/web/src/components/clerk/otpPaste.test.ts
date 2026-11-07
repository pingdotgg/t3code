import { describe, expect, it } from "vite-plus/test";

import { normalizePastedOtpCode } from "./otpPaste";

describe("normalizePastedOtpCode", () => {
  it("leaves clean codes to the field itself", () => {
    expect(normalizePastedOtpCode("123456", 6)).toBeNull();
  });

  it("strips whitespace and separators that email clients copy with the code", () => {
    expect(normalizePastedOtpCode(" 123456", 6)).toBe("123456");
    expect(normalizePastedOtpCode("123456\n", 6)).toBe("123456");
    expect(normalizePastedOtpCode(" 123456​", 6)).toBe("123456");
    expect(normalizePastedOtpCode("123 456", 6)).toBe("123456");
    expect(normalizePastedOtpCode("123-456", 6)).toBe("123456");
  });

  it("ignores text that is not a code", () => {
    expect(normalizePastedOtpCode("Your code is 123456", 6)).toBeNull();
    expect(normalizePastedOtpCode("1234 5678", 6)).toBeNull();
    expect(normalizePastedOtpCode("   ", 6)).toBeNull();
  });
});
