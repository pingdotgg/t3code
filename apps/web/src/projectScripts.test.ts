import { describe, expect, it } from "vitest";

import {
  commandForProjectScript,
  injectEnvIntoShellCommand,
  nextProjectScriptId,
  primaryProjectScript,
  projectScriptIdFromCommand,
  setupProjectScript,
} from "./projectScripts";

describe("projectScripts helpers", () => {
  it("builds and parses script run commands", () => {
    const command = commandForProjectScript("lint");
    expect(command).toBe("script.lint.run");
    expect(projectScriptIdFromCommand(command)).toBe("lint");
    expect(projectScriptIdFromCommand("terminal.toggle")).toBeNull();
  });

  it("slugifies and dedupes project script ids", () => {
    expect(nextProjectScriptId("Run Tests", [])).toBe("run-tests");
    expect(nextProjectScriptId("Run Tests", ["run-tests"])).toBe("run-tests-2");
    expect(nextProjectScriptId("!!!", [])).toBe("script");
  });

  it("injects environment variables for posix shells", () => {
    const command = injectEnvIntoShellCommand("bun install", { T3CODE_PROJECT_ROOT: "/tmp/project" }, "MacIntel");
    expect(command).toBe("env T3CODE_PROJECT_ROOT='/tmp/project' bun install");
  });

  it("injects environment variables for windows shells", () => {
    const command = injectEnvIntoShellCommand("bun install", { T3CODE_PROJECT_ROOT: "C:\\\\repo path" }, "Win32");
    expect(command).toBe('set "T3CODE_PROJECT_ROOT=C:\\\\repo path" && bun install');
  });

  it("resolves primary and setup scripts", () => {
    const scripts = [
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure" as const,
        runOnWorktreeCreate: true,
      },
      {
        id: "test",
        name: "Test",
        command: "bun test",
        icon: "test" as const,
        runOnWorktreeCreate: false,
      },
    ];

    expect(primaryProjectScript(scripts)?.id).toBe("test");
    expect(setupProjectScript(scripts)?.id).toBe("setup");
  });
});
