import { describe, expect, it } from "vite-plus/test";

import { middleTruncateAttachmentName } from "./composerInlineChip";

describe("middleTruncateAttachmentName", () => {
  it("keeps decomposed Hangul syllables whole", () => {
    const name = "아주긴파일이름테스트 스크린샷 2026-11-05 오후 10.59.14.png".normalize("NFD");
    expect(middleTruncateAttachmentName(name).normalize("NFC")).toBe(
      "아주긴파일이름테스트 스크린샷 2026-…후 10.59.14.png",
    );
  });

  it.each([
    ["ZWJ emoji", "\u{1F468}‍\u{1F469}‍\u{1F467}"],
    ["flag", "\u{1F1F0}\u{1F1F7}"],
  ])("keeps %s clusters whole", (_label, cluster) => {
    const name = `abcdefghijklmnopqrst${cluster}0123456789abcdefghijklmnopqrstuvwxyz`;
    expect(middleTruncateAttachmentName(name)).toBe(
      `abcdefghijklmnopqrst${cluster}…mnopqrstuvwxyz`,
    );
  });
});
