import { describe, expect, it } from "vite-plus/test";

import { githubHeadingSlug } from "./markdownFragments";

describe("githubHeadingSlug", () => {
  it.each([
    ["Area of r²", "area-of-r"],
    ["Ⓜ\uFE0F Metro", "ⓜ\uFE0F-metro"],
    ["می\u200Cخواهم", "می\u200Cخواهم"],
  ])("slugs %j like GitHub", (heading, expected) => {
    expect(githubHeadingSlug(heading)).toBe(expected);
  });
});
