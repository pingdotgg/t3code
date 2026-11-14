import { describe, expect, it } from "vite-plus/test";

import { themeCssLoadsRemoteFiles, themeCssValueFetches } from "./themeCss.ts";

// %23 decodes to # inside the SVG, so url(%23g) names its own gradient.
const SVG_WITH_OWN_GRADIENT =
  "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22%3E%3ClinearGradient id=%22g%22/%3E%3Crect fill=%22url(%23g)%22/%3E%3C/svg%3E";

describe("themeCssValueFetches", () => {
  it.each([
    ["background-image", 'url("https://example.com/a")', true],
    ["background-image", 'url("/api/thing")', true],
    ["background-image", 'image-set("https://example.com/a" 1x)', true],
    // An unparsed value keeps its escapes, so an escaped function name hides in it.
    ["--leak", "u\\72l(https://example.com/a)", true],
    ["background-image", "im\\61ge-set(var(--leak) 1x)", true],
    ["background-image", "v\\61r(--none, u\\72l(https://example.com/a))", true],
    // A no-break space before the scheme makes this a path on the app's own origin.
    ["background-image", 'url("\u00a0data:/../../probe")', true],
    ["background-image", 'url("data:image/png;base64,AA")', false],
    ["background-image", `url("${SVG_WITH_OWN_GRADIENT}")`, false],
    // The url( sits inside a string, so the address after that string is a real remote url().
    ["content", `"url('data:" url("https://evil.example/a") "'"`, true],
    ["filter", 'url("#blur")', false],
    ["background-image", "var(--pattern)", false],
    ["color", "red", false],
  ])("%s: %s", (_property, value, fetches) => {
    expect(themeCssValueFetches(value)).toBe(fetches);
  });
});

describe("themeCssLoadsRemoteFiles", () => {
  it("allows a url() inside a data: address", () => {
    expect(
      themeCssLoadsRemoteFiles(`.repro { background-image: url('${SVG_WITH_OWN_GRADIENT}'); }`),
    ).toBe(false);
  });
});
