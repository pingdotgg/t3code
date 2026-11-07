import { describe, expect, it } from "vite-plus/test";

import { resolveProjectFaviconColorScheme } from "./projectFaviconColorScheme";

const svgDataUrl = (svg: string) =>
  `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
const decode = (dataUrl: string) =>
  Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64").toString("utf8");

const PATH = `<path d="M 40 220 L 220 40 L 400 220 L 220 400 Z"/>`;
// Strokes with currentColor and switches the root color per scheme with @media.
const ISSUE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 440 440" fill="none" stroke="currentColor" stroke-width="9"><style>:root{color:#111827}@media(prefers-color-scheme:dark){:root{color:#F8FAFC}}</style>${PATH}</svg>`;

describe("resolveProjectFaviconColorScheme", () => {
  it("gives the root the dark color the stylesheet picks in dark mode", () => {
    const resolved = decode(resolveProjectFaviconColorScheme(svgDataUrl(ISSUE_ICON), "dark"));

    expect(resolved).toBe(
      `<svg color="#F8FAFC" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 440 440" fill="none" stroke="currentColor" stroke-width="9"><style>:root{color:#111827}:root{color:#F8FAFC}</style>${PATH}</svg>`,
    );
  });

  it("gives the root the light color in light mode", () => {
    const resolved = decode(resolveProjectFaviconColorScheme(svgDataUrl(ISSUE_ICON), "light"));

    expect(resolved).toBe(
      `<svg color="#111827" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 440 440" fill="none" stroke="currentColor" stroke-width="9"><style>:root{color:#111827}</style>${PATH}</svg>`,
    );
  });

  it("keeps the rules of the matching color-scheme block and drops the other", () => {
    const icon = `<svg xmlns="http://www.w3.org/2000/svg"><style>.a{fill:#000} @media (prefers-color-scheme: dark) { .a{fill:#fff} .b{stroke:#eee} } @media (prefers-color-scheme: light) { .b{stroke:#111} }</style></svg>`;

    expect(decode(resolveProjectFaviconColorScheme(svgDataUrl(icon), "dark"))).toBe(
      `<svg xmlns="http://www.w3.org/2000/svg"><style>.a{fill:#000}  .a{fill:#fff} .b{stroke:#eee}  </style></svg>`,
    );
    expect(decode(resolveProjectFaviconColorScheme(svgDataUrl(icon), "light"))).toBe(
      `<svg xmlns="http://www.w3.org/2000/svg"><style>.a{fill:#000}   .b{stroke:#111} </style></svg>`,
    );
  });

  it("replaces an existing root color attribute", () => {
    const icon = `<svg xmlns="http://www.w3.org/2000/svg" color='red' stroke="currentColor"><style>svg{color:blue}</style></svg>`;

    expect(decode(resolveProjectFaviconColorScheme(svgDataUrl(icon), "light"))).toBe(
      `<svg color="blue" xmlns="http://www.w3.org/2000/svg" stroke="currentColor"><style>svg{color:blue}</style></svg>`,
    );
  });

  it("takes the last root color declaration outside other at-rules", () => {
    const icon = `<svg xmlns="http://www.w3.org/2000/svg"><style>:root{color:red;color:blue}@media print{:root{color:green}}</style></svg>`;

    expect(decode(resolveProjectFaviconColorScheme(svgDataUrl(icon), "light"))).toBe(
      `<svg color="blue" xmlns="http://www.w3.org/2000/svg"><style>:root{color:red;color:blue}@media print{:root{color:green}}</style></svg>`,
    );
    const variable = icon.replace("color:blue", "color:var(--icon)");
    expect(resolveProjectFaviconColorScheme(svgDataUrl(variable), "dark")).toBe(
      svgDataUrl(variable),
    );
    const media = `<svg><style>:root{color:blue}</style><style media="(prefers-color-scheme: dark)">:root{color:white}.a{fill:white}</style><style media="print">:root{color:red}</style></svg>`;
    expect(decode(resolveProjectFaviconColorScheme(svgDataUrl(media), "light"))).toBe(
      `<svg color="blue"><style>:root{color:blue}</style><style media="print">:root{color:red}</style></svg>`,
    );
    expect(decode(resolveProjectFaviconColorScheme(svgDataUrl(media), "dark"))).toBe(
      `<svg color="white"><style>:root{color:blue}</style><style>:root{color:white}.a{fill:white}</style><style media="print">:root{color:red}</style></svg>`,
    );
  });

  it("lets an important root color beat later normal ones", () => {
    const icon = `<svg xmlns="http://www.w3.org/2000/svg"><style>:root{color:#111 !important}@media (prefers-color-scheme: dark){:root{color:#fff!important}}:root{color:red}</style></svg>`;

    expect(decode(resolveProjectFaviconColorScheme(svgDataUrl(icon), "dark"))).toBe(
      `<svg color="#fff" xmlns="http://www.w3.org/2000/svg"><style>:root{color:#111 !important}:root{color:#fff!important}:root{color:red}</style></svg>`,
    );
    expect(decode(resolveProjectFaviconColorScheme(svgDataUrl(icon), "light"))).toBe(
      `<svg color="#111" xmlns="http://www.w3.org/2000/svg"><style>:root{color:#111 !important}:root{color:red}</style></svg>`,
    );
  });

  it("keeps an important root color across style elements", () => {
    const icon = `<svg xmlns="http://www.w3.org/2000/svg"><style>:root{color:#fff !important}</style><style>:root{color:#000}</style></svg>`;

    expect(decode(resolveProjectFaviconColorScheme(svgDataUrl(icon), "dark"))).toBe(
      `<svg color="#fff" xmlns="http://www.w3.org/2000/svg"><style>:root{color:#fff !important}</style><style>:root{color:#000}</style></svg>`,
    );
  });

  it("ignores braces and color-scheme blocks inside CSS comments", () => {
    const icon = `<svg xmlns="http://www.w3.org/2000/svg"><style>/* @media (prefers-color-scheme: dark) { */.a{fill:#000}/* } */@media (prefers-color-scheme: dark){/* } */.a{fill:#fff}}</style></svg>`;

    expect(decode(resolveProjectFaviconColorScheme(svgDataUrl(icon), "light"))).toBe(
      `<svg xmlns="http://www.w3.org/2000/svg"><style>.a{fill:#000}</style></svg>`,
    );
    expect(decode(resolveProjectFaviconColorScheme(svgDataUrl(icon), "dark"))).toBe(
      `<svg xmlns="http://www.w3.org/2000/svg"><style>.a{fill:#000}.a{fill:#fff}</style></svg>`,
    );
  });

  it("colors the root element, not an svg tag in an earlier comment", () => {
    const icon = `<!-- <svg width="1"> --><SVG xmlns="http://www.w3.org/2000/svg"><style>:root{color:#fff}</style></SVG>`;

    expect(decode(resolveProjectFaviconColorScheme(svgDataUrl(icon), "dark"))).toBe(
      `<!-- <svg width="1"> --><SVG color="#fff" xmlns="http://www.w3.org/2000/svg"><style>:root{color:#fff}</style></SVG>`,
    );
  });

  it("leaves other media queries for the renderer", () => {
    const icon = `<svg xmlns="http://www.w3.org/2000/svg"><style>@media screen and (prefers-color-scheme: dark){.a{fill:#fff}}@media not (prefers-color-scheme: dark){.a{fill:#000}}</style></svg>`;

    expect(resolveProjectFaviconColorScheme(svgDataUrl(icon), "dark")).toBe(svgDataUrl(icon));
  });

  it("ignores a root color that is not a plain color value", () => {
    const icon = `<svg xmlns="http://www.w3.org/2000/svg"><style>:root{color:red$'}</style></svg>`;

    expect(resolveProjectFaviconColorScheme(svgDataUrl(icon), "dark")).toBe(svgDataUrl(icon));
  });

  it("ignores style elements inside XML comments", () => {
    const icon = `<svg xmlns="http://www.w3.org/2000/svg"><style>:root{color:blue}</style><!-- <style>:root{color:red!important}</style> --></svg>`;

    expect(decode(resolveProjectFaviconColorScheme(svgDataUrl(icon), "dark"))).toBe(
      icon.replace("<svg ", '<svg color="blue" '),
    );
  });

  it("keeps root selector specificity across style elements", () => {
    const icon = `<svg xmlns="http://www.w3.org/2000/svg"><style>:root{color:blue}</style><style>svg{color:red}</style></svg>`;

    expect(decode(resolveProjectFaviconColorScheme(svgDataUrl(icon), "dark"))).toBe(
      icon.replace("<svg ", '<svg color="blue" '),
    );
    const important = icon.replace("color:red", "color:red!important");
    expect(decode(resolveProjectFaviconColorScheme(svgDataUrl(important), "dark"))).toBe(
      important.replace("<svg ", '<svg color="red" '),
    );
  });

  it("returns non-SVG and remote URLs unchanged", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const remote = "https://host/api/assets/token/icon.svg";

    expect(resolveProjectFaviconColorScheme(png, "dark")).toBe(png);
    expect(resolveProjectFaviconColorScheme(remote, "dark")).toBe(remote);
  });
});
