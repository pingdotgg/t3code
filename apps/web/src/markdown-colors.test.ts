import { describe, expect, it } from "vite-plus/test";

import { resolveInlineCodeColor } from "./markdown-colors";

describe("resolveInlineCodeColor", () => {
  it("resolves hex literals of every length", () => {
    expect(resolveInlineCodeColor("#FFB3C6")).toBe("#FFB3C6");
    expect(resolveInlineCodeColor("#fdf6e3")).toBe("#fdf6e3");
    expect(resolveInlineCodeColor("#abc")).toBe("#abc");
    expect(resolveInlineCodeColor("#abcd")).toBe("#abcd");
    expect(resolveInlineCodeColor("#ff00aa80")).toBe("#ff00aa80");
  });

  it("resolves functional color notations", () => {
    expect(resolveInlineCodeColor("rgb(255, 179, 198)")).toBe("rgb(255, 179, 198)");
    expect(resolveInlineCodeColor("rgba(255 179 198 / 0.5)")).toBe("rgba(255 179 198 / 0.5)");
    expect(resolveInlineCodeColor("hsl(340 100% 85%)")).toBe("hsl(340 100% 85%)");
    expect(resolveInlineCodeColor("oklch(0.86 0.09 5.2)")).toBe("oklch(0.86 0.09 5.2)");
  });

  it("ignores surrounding whitespace", () => {
    expect(resolveInlineCodeColor("  #FFB3C6 ")).toBe("#FFB3C6");
  });

  it("rejects text that merely contains a color", () => {
    expect(resolveInlineCodeColor("color: #FFB3C6")).toBeNull();
    expect(resolveInlineCodeColor("#FFB3C6 on cream")).toBeNull();
  });

  it("rejects hex-shaped values that aren't colors", () => {
    expect(resolveInlineCodeColor("#ff")).toBeNull();
    expect(resolveInlineCodeColor("#fffffff")).toBeNull();
    expect(resolveInlineCodeColor("#zzzzzz")).toBeNull();
    expect(resolveInlineCodeColor("a1b2c3")).toBeNull();
  });

  it("rejects bare color keywords, which read as prose far more often than as colors", () => {
    expect(resolveInlineCodeColor("red")).toBeNull();
    expect(resolveInlineCodeColor("tan")).toBeNull();
  });

  it("rejects unknown or injection-shaped function calls", () => {
    expect(resolveInlineCodeColor("url(evil.png)")).toBeNull();
    expect(resolveInlineCodeColor("rgb(0,0,0); background: url(x)")).toBeNull();
    expect(resolveInlineCodeColor("rgb(var(--x))")).toBeNull();
  });

  it("rejects empty and oversized spans", () => {
    expect(resolveInlineCodeColor("")).toBeNull();
    expect(resolveInlineCodeColor(`rgb(${"0".repeat(80)})`)).toBeNull();
  });
});
