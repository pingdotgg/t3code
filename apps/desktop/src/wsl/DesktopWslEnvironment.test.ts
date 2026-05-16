import { describe, it, expect } from "vitest";

import { formatMissingToolsReason, parseToolchainReport } from "./DesktopWslEnvironment.ts";

describe("parseToolchainReport", () => {
  it("returns no missing tools and no node version on empty output", () => {
    expect(parseToolchainReport("")).toEqual({ missingTools: [], nodeVersion: null });
  });

  it("collects all missing: lines", () => {
    const stdout = ["missing:make", "missing:g++", "nodeVersion:24.10.0"].join("\n");
    expect(parseToolchainReport(stdout)).toEqual({
      missingTools: ["make", "g++"],
      nodeVersion: "24.10.0",
    });
  });

  it("ignores blank lines and trims whitespace", () => {
    const stdout = ["  missing:python3  ", "", "  nodeVersion:v22.16.0  "].join("\n");
    expect(parseToolchainReport(stdout)).toEqual({
      missingTools: ["python3"],
      nodeVersion: "v22.16.0",
    });
  });

  it("returns null node version when value after prefix is empty", () => {
    expect(parseToolchainReport("nodeVersion:")).toEqual({
      missingTools: [],
      nodeVersion: null,
    });
  });
});

describe("formatMissingToolsReason", () => {
  it("returns null when everything is present and node is in range", () => {
    expect(
      formatMissingToolsReason({ missingTools: [], nodeVersion: "24.10.0" }, "^24.10"),
    ).toBeNull();
  });

  it("returns null when range is not specified and tools are present", () => {
    expect(formatMissingToolsReason({ missingTools: [], nodeVersion: "18.0.0" }, null)).toBeNull();
  });

  it("flags missing node first", () => {
    const reason = formatMissingToolsReason(
      { missingTools: ["node", "make"], nodeVersion: null },
      "^24.10",
    );
    expect(reason).toContain("node");
    expect(reason).toContain("^24.10");
    expect(reason).toContain("make");
    expect(reason).toContain("nvm");
  });

  it("flags an out-of-range node version with the actual version surfaced", () => {
    const reason = formatMissingToolsReason(
      { missingTools: [], nodeVersion: "20.0.0" },
      "^24.10 || ^22.16",
    );
    expect(reason).toContain("node 20.0.0");
    expect(reason).toContain("requires ^24.10 || ^22.16");
  });

  it("flags missing build tools without node when node is fine", () => {
    const reason = formatMissingToolsReason(
      { missingTools: ["g++", "python3"], nodeVersion: "24.10.0" },
      "^24.10",
    );
    expect(reason).toContain("g++");
    expect(reason).toContain("python3");
    expect(reason).toContain("build-essential");
    expect(reason).not.toContain("nvm");
  });
});
