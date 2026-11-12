import { describe, expect, it } from "vite-plus/test";

import { themeCssValueFetches } from "./themeCss.ts";

describe("themeCssValueFetches", () => {
  it.each([
    ["background-image", 'url("https://example.com/a")', true],
    ["background-image", 'url("/api/thing")', true],
    ["background-image", 'image-set("https://example.com/a" 1x)', true],
    // An unparsed value keeps its escapes, so an escaped function name hides in it.
    ["--leak", "u\\72l(https://example.com/a)", true],
    ["background-image", "im\\61ge-set(var(--leak) 1x)", true],
    ["background-image", 'url("data:image/png;base64,AA")', false],
    ["filter", 'url("#blur")', false],
    ["background-image", "var(--pattern)", false],
    ["content", '"\\201C"', false],
    ["color", "red", false],
  ])("%s: %s", (property, value, fetches) => {
    expect(themeCssValueFetches(property, value)).toBe(fetches);
  });
});
