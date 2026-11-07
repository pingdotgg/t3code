// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vitest";

import { isLiveDataDir } from "./learner-e2e.ts";

it("refuses base dirs inside the live data folders, through links too", () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "learner-e2e-home-"));
  try {
    NodeFS.mkdirSync(NodePath.join(home, ".ominax", "userdata"), { recursive: true });
    NodeFS.symlinkSync(NodePath.join(home, ".ominax"), NodePath.join(home, ".t3-learn"));
    NodeFS.mkdirSync(NodePath.join(home, ".t3"));
    NodeFS.mkdirSync(NodePath.join(home, ".t3x"));

    expect(isLiveDataDir(NodePath.join(home, ".t3"), home)).toBe(true);
    expect(isLiveDataDir(NodePath.join(home, ".t3-learn", "userdata"), home)).toBe(true);
    expect(isLiveDataDir(NodePath.join(home, ".t3x"), home)).toBe(false);
    expect(isLiveDataDir(NodeOS.tmpdir(), home)).toBe(false);
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});
