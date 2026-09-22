import * as Encoding from "effect/Encoding";
import { describe, expect, it } from "vite-plus/test";

import { resolveFaviconUrlAppearance, resolveSvgAppearance } from "./projectFaviconAppearance";

const ADAPTIVE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 440 440" fill="none" stroke="currentColor" stroke-width="9">
  <style>:root{color:#111827}@media(prefers-color-scheme:dark){:root{color:#F8FAFC}}</style>
  <path d="M 40 220 L 220 40 L 400 220 L 220 400 Z"/>
</svg>`;

describe("resolveSvgAppearance", () => {
  it("applies the dark media query and substitutes currentColor", () => {
    const resolved = resolveSvgAppearance(ADAPTIVE_SVG, "dark");
    expect(resolved).toContain('stroke="#F8FAFC"');
    expect(resolved).not.toContain("@media");
    expect(resolved).not.toContain("currentColor");
  });

  it("drops the dark media query in light mode", () => {
    const resolved = resolveSvgAppearance(ADAPTIVE_SVG, "light");
    expect(resolved).toContain('stroke="#111827"');
    expect(resolved).not.toContain("#F8FAFC");
  });

  it("falls back to black when no color is declared", () => {
    expect(resolveSvgAppearance('<svg><path fill="currentColor"/></svg>', "dark")).toBe(
      '<svg><path fill="#000"/></svg>',
    );
  });

  it("leaves unrelated media queries and static colors alone", () => {
    const svg =
      '<svg><style>@media (min-width: 10px){.a{fill:red}}</style><path fill="red"/></svg>';
    expect(resolveSvgAppearance(svg, "dark")).toBe(svg);
  });
});

describe("resolveFaviconUrlAppearance", () => {
  it("re-encodes inline SVGs and passes other sources through", () => {
    const url = `data:image/svg+xml;base64,${Encoding.encodeBase64(ADAPTIVE_SVG)}`;
    const resolved = resolveFaviconUrlAppearance(url, "dark");
    expect(resolved).not.toBe(url);
    expect(resolved.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(resolveFaviconUrlAppearance("data:image/png;base64,AAAA", "dark")).toBe(
      "data:image/png;base64,AAAA",
    );
    expect(resolveFaviconUrlAppearance("https://example.test/icon.svg", "dark")).toBe(
      "https://example.test/icon.svg",
    );
  });
});
