// @effect-diagnostics nodeBuiltinImport:off
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { expandHomePath } from "./pathExpansion.ts";

describe("expandHomePath", () => {
  it("returns an empty string unchanged", () => {
    expect(expandHomePath("")).toBe("");
  });

  it("returns paths without a leading tilde unchanged", () => {
    expect(expandHomePath("/absolute/path")).toBe("/absolute/path");
    expect(expandHomePath("relative/path")).toBe("relative/path");
    expect(expandHomePath("some~weird~path")).toBe("some~weird~path");
  });

  it("expands a lone tilde to the home directory", () => {
    expect(expandHomePath("~")).toBe(homedir());
  });

  it("expands ~/ to a subpath of the home directory", () => {
    expect(expandHomePath("~/.codex-work")).toBe(join(homedir(), ".codex-work"));
  });

  it("expands a Windows-style ~\\ prefix", () => {
    expect(expandHomePath("~\\.codex")).toBe(join(homedir(), ".codex"));
  });

  it("does not expand ~user paths", () => {
    expect(expandHomePath("~alice/foo")).toBe("~alice/foo");
  });
});
