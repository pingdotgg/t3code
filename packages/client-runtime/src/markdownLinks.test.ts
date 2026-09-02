import { describe, expect, it } from "vite-plus/test";

import { inlineCodeFilePathCandidate, isConventionalFilePosition } from "./markdownLinks.js";

describe("inlineCodeFilePathCandidate", () => {
  it.each([
    ["src\\main.ts", "src/main.ts"],
    ["C:\\Users\\demo\\image.png", "C:\\Users\\demo\\image.png"],
    ["\\\\server\\share\\image.png", "\\\\server\\share\\image.png"],
    ["conf.d/nginx.conf", "conf.d/nginx.conf"],
    ["script.pl:10", "script.pl:10"],
    ["node.meta", null],
    ["Recorded evidence here: /tmp/image.png", null],
    ["origin/main", null],
    ["127.0.0.1:3000", null],
    ["example.com/index.html", null],
    ["example.pl/index.html", null],
  ])("distinguishes file paths from code and hostnames in %s", (source, candidate) => {
    expect(inlineCodeFilePathCandidate(source)).toBe(candidate);
  });
});

describe("isConventionalFilePosition", () => {
  it("distinguishes extensionless file locations from labels and ports", () => {
    expect(isConventionalFilePosition("Dockerfile:8:2")).toBe(true);
    expect(isConventionalFilePosition("Makefile")).toBe(false);
    expect(isConventionalFilePosition("TODO:12")).toBe(false);
    expect(isConventionalFilePosition("port:3000")).toBe(false);
  });
});
