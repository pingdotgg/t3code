import { describe, expect, it } from "vite-plus/test";

import {
  generateProjectFaviconSvg,
  generateProjectReadme,
  slugifyProjectName,
} from "./projectScaffold.ts";

describe("slugifyProjectName", () => {
  it("lowercases and dashes word boundaries", () => {
    expect(slugifyProjectName("Cool Idea 3")).toBe("cool-idea-3");
    expect(slugifyProjectName("  spaced   out  ")).toBe("spaced-out");
  });

  it("collapses symbol runs into single dashes", () => {
    expect(slugifyProjectName("t3.chat // clone!")).toBe("t3-chat-clone");
  });

  it("strips leading and trailing separators", () => {
    expect(slugifyProjectName("--edgy--")).toBe("edgy");
  });

  it("returns empty when nothing survives", () => {
    expect(slugifyProjectName("!!!")).toBe("");
    expect(slugifyProjectName("   ")).toBe("");
  });

  it("caps length without a dangling dash", () => {
    const slug = slugifyProjectName(`${"a".repeat(63)} tail`);
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("generateProjectFaviconSvg", () => {
  it("is deterministic for the same name", () => {
    expect(generateProjectFaviconSvg("Cool Idea")).toBe(generateProjectFaviconSvg("Cool Idea"));
  });

  it("uses the first alphanumeric character uppercased", () => {
    expect(generateProjectFaviconSvg("cool idea")).toContain(">C</text>");
    expect(generateProjectFaviconSvg("~scratch")).toContain(">S</text>");
  });

  it("escapes names with no alphanumeric characters", () => {
    expect(generateProjectFaviconSvg("<>")).toContain(">&lt;</text>");
  });

  it("keeps hue inside the hsl wheel", () => {
    const hue = Number(/hsl\((\d+) /.exec(generateProjectFaviconSvg("anything"))?.[1]);
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(360);
  });
});

describe("generateProjectReadme", () => {
  it("contains the name and the T3 Code line", () => {
    expect(generateProjectReadme("Cool Idea")).toBe("# Cool Idea\n\nInitialized with T3 Code.\n");
  });
});
