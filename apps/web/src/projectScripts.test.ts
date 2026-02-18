import { describe, expect, it } from "vitest";

import {
  commandForProjectScript,
  injectEnvIntoShellCommand,
  nextProjectScriptId,
  primaryProjectScript,
  projectScriptRuntimeEnv,
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

  it("escapes windows env values that trigger interpolation", () => {
    const command = injectEnvIntoShellCommand(
      "bun install",
      { T3CODE_PROJECT_ROOT: '%USERPROFILE%^"repo"' },
      "Win32",
    );
    expect(command).toBe('set "T3CODE_PROJECT_ROOT=^%USERPROFILE^%^^""repo""" && bun install');
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

  it("builds default runtime env for scripts", () => {
    const env = projectScriptRuntimeEnv({
      project: { id: "project-1", name: "acme-web", cwd: "/repo" },
      script: {
        id: "test",
        name: "Test",
        icon: "test",
        runOnWorktreeCreate: false,
      },
      threadId: "thread-1",
      worktreePath: "/repo/worktree-a",
    });

    expect(env).toMatchObject({
      T3CODE_PROJECT_ROOT: "/repo",
      T3CODE_PROJECT_ID: "project-1",
      T3CODE_PROJECT_NAME: "acme-web",
      T3CODE_THREAD_ID: "thread-1",
      T3CODE_SCRIPT_ID: "test",
      T3CODE_SCRIPT_NAME: "Test",
      T3CODE_SCRIPT_ICON: "test",
      T3CODE_SCRIPT_IS_SETUP: "0",
      T3CODE_WORKTREE_PATH: "/repo/worktree-a",
    });
  });

  it("allows overriding runtime env values", () => {
    const env = projectScriptRuntimeEnv({
      project: { id: "project-1", name: "acme-web", cwd: "/repo" },
      script: {
        id: "setup",
        name: "Setup",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
      threadId: "thread-1",
      extraEnv: {
        T3CODE_PROJECT_ROOT: "/custom-root",
        CUSTOM_FLAG: "1",
      },
    });

    expect(env.T3CODE_PROJECT_ROOT).toBe("/custom-root");
    expect(env.T3CODE_SCRIPT_IS_SETUP).toBe("1");
    expect(env.CUSTOM_FLAG).toBe("1");
    expect(env.T3CODE_WORKTREE_PATH).toBeUndefined();
  });
});
