import { describe, expect, it } from "vite-plus/test";

import { githubHeadingSlug } from "./markdownFragments";

describe("githubHeadingSlug", () => {
  it.each([
    ["Area of r²", "area-of-r"],
    ["Step ①", "step-"],
    ["x₂ sub", "x-sub"],
    ["Ⓜ\uFE0F Metro", "ⓜ\uFE0F-metro"],
    ["می\u200Cخواهم", "می\u200Cخواهم"],
    ["👨\u200D👩\u200D👧 Family", "\u200D\u200D-family"],
    ["Ⅻ Café", "ⅻ-café"],
    ["snake_case v2.0 – notes", "snake_case-v20--notes"],
  ])("slugs %j like GitHub", (heading, expected) => {
    expect(githubHeadingSlug(heading)).toBe(expected);
  });
});
