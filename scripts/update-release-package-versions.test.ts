import { describe, expect, it } from "vitest";

import { parseArgs } from "./update-release-package-versions.ts";

describe("parseArgs", () => {
  it("parses version only", () => {
    expect(parseArgs(["1.2.3"])).toEqual({
      version: "1.2.3",
      rootDir: undefined,
      writeGithubOutput: false,
    });
  });

  it("parses version with --root", () => {
    expect(parseArgs(["1.2.3", "--root", "/path"])).toEqual({
      version: "1.2.3",
      rootDir: "/path",
      writeGithubOutput: false,
    });
  });

  it("parses version with --github-output", () => {
    expect(parseArgs(["1.2.3", "--github-output"])).toEqual({
      version: "1.2.3",
      rootDir: undefined,
      writeGithubOutput: true,
    });
  });

  it("parses version with --root and --github-output", () => {
    expect(parseArgs(["1.2.3", "--root", "/path", "--github-output"])).toEqual({
      version: "1.2.3",
      rootDir: "/path",
      writeGithubOutput: true,
    });
  });

  it("accepts flags before the version positional", () => {
    expect(parseArgs(["--github-output", "--root", "/path", "1.2.3"])).toEqual({
      version: "1.2.3",
      rootDir: "/path",
      writeGithubOutput: true,
    });
  });

  it("throws on missing version", () => {
    expect(() => parseArgs([])).toThrow("Usage:");
  });

  it("throws on duplicate version", () => {
    expect(() => parseArgs(["1.2.3", "2.0.0"])).toThrow(
      "Only one release version can be provided.",
    );
  });

  it("throws on unknown flag", () => {
    expect(() => parseArgs(["1.2.3", "--unknown"])).toThrow("Unknown argument: --unknown");
  });

  it("throws on --root without value", () => {
    expect(() => parseArgs(["1.2.3", "--root"])).toThrow("Missing value for --root.");
  });

  it("does not consume version as --github-output value", () => {
    expect(parseArgs(["--github-output", "1.2.3"])).toEqual({
      version: "1.2.3",
      rootDir: undefined,
      writeGithubOutput: true,
    });
  });
});
