// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { expandHomePath } from "./pathExpansion.ts";

const home = "/home/ada";

describe("expandHomePath", () => {
  it("returns an empty string unchanged", () => {
    expect(expandHomePath("", home)).toBe("");
  });

  it("returns paths without a leading tilde unchanged", () => {
    expect(expandHomePath("/absolute/path", home)).toBe("/absolute/path");
    expect(expandHomePath("relative/path", home)).toBe("relative/path");
    expect(expandHomePath("some~weird~path", home)).toBe("some~weird~path");
  });

  it("expands a lone tilde to the home directory", () => {
    expect(expandHomePath("~", home)).toBe(home);
  });

  it("expands ~/ to a subpath of the home directory", () => {
    expect(expandHomePath("~/.codex-work", home)).toBe(NodePath.join(home, ".codex-work"));
  });

  it("expands a Windows-style ~\\ prefix", () => {
    expect(expandHomePath("~\\.codex", home)).toBe(NodePath.join(home, ".codex"));
  });

  it("does not expand ~user paths", () => {
    expect(expandHomePath("~alice/foo", home)).toBe("~alice/foo");
  });
});
