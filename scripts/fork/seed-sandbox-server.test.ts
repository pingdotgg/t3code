import { describe, expect, it } from "vite-plus/test";

import {
  archiveTarget,
  archiveVersion,
  parseArguments,
  releaseMetaVersion,
} from "./seed-sandbox-server.ts";

describe("archiveTarget", () => {
  it("picks the archive the SSH installer would download", () => {
    expect(archiveTarget("Linux", "x86_64")).toBe("linux-x64");
    expect(archiveTarget("Linux", "aarch64")).toBe("linux-arm64");
    expect(archiveTarget("Darwin", "arm64")).toBe("darwin-arm64");
  });

  it("has nothing for a host no archive is built for", () => {
    expect(archiveTarget("FreeBSD", "x86_64")).toBeUndefined();
    expect(archiveTarget("Linux", "riscv64")).toBeUndefined();
  });
});

describe("archiveVersion", () => {
  it("reads the version from the archive's name", () => {
    expect(archiveVersion("t3-0.0.46-preview.20261011.5-linux-x64.tar.gz", "linux-x64")).toBe(
      "0.0.46-preview.20261011.5",
    );
  });

  it("rejects other files and versions unsafe in a shell command", () => {
    expect(archiveVersion("t3-0.0.46-linux-arm64.tar.gz", "linux-x64")).toBeUndefined();
    expect(archiveVersion("SHA256SUMS", "linux-x64")).toBeUndefined();
    expect(archiveVersion("t3--linux-x64.tar.gz", "linux-x64")).toBeUndefined();
    expect(archiveVersion("t3-1;rm -rf ~-linux-x64.tar.gz", "linux-x64")).toBeUndefined();
  });
});

describe("parseArguments", () => {
  it("takes a run id and an Agent name in any order", () => {
    expect(parseArguments(["--agent", "t3code-dev-nested-1", "--run", "38161523513"])).toEqual({
      run: "38161523513",
      agent: "t3code-dev-nested-1",
    });
  });

  it("takes a run alone, to print its version", () => {
    expect(parseArguments(["--run", "38161523513"])).toEqual({
      run: "38161523513",
      agent: undefined,
    });
  });

  it("refuses a missing value, an unknown flag or a run that is not an id", () => {
    expect(() => parseArguments(["--run", "--agent", "a"])).toThrow();
    expect(() => parseArguments(["--run", "1", "--agent", "a", "--force"])).toThrow();
    expect(() => parseArguments(["--run", "latest", "--agent", "a"])).toThrow();
    expect(() => parseArguments(["--agent", "a"])).toThrow();
  });
});

describe("releaseMetaVersion", () => {
  it("reads the version the release workflow recorded", () => {
    const text = "version=0.0.46-preview.20261011.6\ntag=v0.0.46-preview.20261011.6\nsha=abc\n";
    expect(releaseMetaVersion(text)).toBe("0.0.46-preview.20261011.6");
  });

  it("has nothing without a usable version", () => {
    expect(releaseMetaVersion("tag=v1\n")).toBeUndefined();
    expect(releaseMetaVersion("version=1;reboot\n")).toBeUndefined();
  });
});
