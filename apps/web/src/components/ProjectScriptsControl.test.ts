import type { ProjectScript, T3ProjectFileScript } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isT3ProjectFileScriptImported } from "./ProjectScriptsControl";

const configuredScript: ProjectScript = {
  id: "setup",
  name: "Setup Worktree",
  command: "vp install",
  icon: "configure",
  runOnWorktreeCreate: true,
};

describe("isT3ProjectFileScriptImported", () => {
  it("matches an imported action by command", () => {
    const fileScript: T3ProjectFileScript = {
      name: "Install",
      command: "vp install",
    };

    expect(isT3ProjectFileScriptImported([configuredScript], fileScript)).toBe(true);
  });

  it("matches an imported action by case-insensitive name", () => {
    const fileScript: T3ProjectFileScript = {
      name: "setup worktree",
      command: "vp run setup",
    };

    expect(isT3ProjectFileScriptImported([configuredScript], fileScript)).toBe(true);
  });

  it("keeps unrelated repository actions importable", () => {
    const fileScript: T3ProjectFileScript = {
      name: "Test",
      command: "vp test",
    };

    expect(isT3ProjectFileScriptImported([configuredScript], fileScript)).toBe(false);
  });
});
