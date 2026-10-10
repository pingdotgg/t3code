import { describe, expect, it } from "vite-plus/test";
import { mathSvg } from "./mathSvg";

describe("native formula SVG", () => {
  it("typesets the growth formula as self-contained paths at the requested size", () => {
    const source = String.raw`\text{Average yearly growth}=\sqrt{\text{factor}_1\times\text{factor}_2}-1`;
    const small = mathSvg(source, true, 15);
    const large = mathSvg(source, true, 30);
    expect(small?.xml).toContain("<path");
    expect(small?.xml).toContain('data-mml-node="msqrt"');
    expect(small?.xml).not.toMatch(/<use|href=/);
    expect(small!.width).toBeGreaterThan(100);
    expect(large!.width).toBeCloseTo(small!.width * 2);
    expect(large!.height).toBeCloseTo(small!.height * 2);
  });

  it.each([
    String.raw`\badcommand{x}`,
    String.raw`\frac{`,
    String.raw`\href{https://example.com}{x}`,
    String.raw`\require{html}`,
  ])("falls back for invalid or unsupported TeX: %s", (source) => {
    expect(mathSvg(source, true, 15)).toBeNull();
  });

  it("isolates macros between messages", () => {
    expect(mathSvg(String.raw`\newcommand{\private}{x}\private`, true, 15)).not.toBeNull();
    expect(mathSvg(String.raw`\private`, true, 15)).toBeNull();
  });
});
