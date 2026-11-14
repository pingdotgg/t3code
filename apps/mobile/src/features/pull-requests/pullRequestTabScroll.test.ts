import { describe, expect, it } from "vite-plus/test";
import { pullRequestTabOffset } from "./pullRequestTabScroll";

describe("pull request tab scroll", () => {
  it("keeps the header fixed while switching, even if the destination was scrolled deeply", () => {
    expect(pullRequestTabOffset(-100, 900, 200)).toBe(-100);
    expect(pullRequestTabOffset(75, 900, 200)).toBe(75);
  });
  it("resumes the destination body only when the shared header is already collapsed", () => {
    expect(pullRequestTabOffset(600, 900, 200)).toBe(900);
    expect(pullRequestTabOffset(600, 50, 200)).toBe(200);
    expect(pullRequestTabOffset(600, undefined, 200)).toBe(200);
  });
  it("retains the saved body offset when native scrolling rounds the collapsed header", () => {
    const headerEnd = 213.6666717529297 - 116;
    expect(pullRequestTabOffset(97.66666666666667, 800, headerEnd)).toBe(800);
    expect(pullRequestTabOffset(headerEnd - 1, 800, headerEnd)).toBe(headerEnd - 1);
  });
});
