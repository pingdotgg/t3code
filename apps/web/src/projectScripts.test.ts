import { describe, expect, it } from "vitest";

import {
  cleanupProjectScript,
  commandForProjectScript,
  nextProjectScriptId,
  primaryProjectScript,
  projectScriptRuntimeEnv,
  projectScriptLifecycleLabel,
  projectScriptIdFromCommand,
  setupProjectScript,
  upsertProjectScript,
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

  it("resolves primary and setup scripts", () => {
    const scripts = [
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure" as const,
        runOnWorktreeCreate: true,
        runOnWorktreeDelete: false,
      },
      {
        id: "cleanup",
        name: "Cleanup",
        command: "git pull --ff-only",
        icon: "configure" as const,
        runOnWorktreeCreate: false,
        runOnWorktreeDelete: true,
      },
      {
        id: "test",
        name: "Test",
        command: "bun test",
        icon: "test" as const,
        runOnWorktreeCreate: false,
        runOnWorktreeDelete: false,
      },
    ];

    expect(primaryProjectScript(scripts)?.id).toBe("test");
    expect(setupProjectScript(scripts)?.id).toBe("setup");
    expect(cleanupProjectScript(scripts)?.id).toBe("cleanup");
  });

  it("falls back to the first script when all actions are lifecycle hooks", () => {
    const scripts = [
      {
        id: "cleanup",
        name: "Cleanup",
        command: "git pull --ff-only",
        icon: "configure" as const,
        runOnWorktreeCreate: false,
        runOnWorktreeDelete: true,
      },
    ];

    expect(primaryProjectScript(scripts)?.id).toBe("cleanup");
  });

  it("formats lifecycle labels", () => {
    expect(
      projectScriptLifecycleLabel({
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
        runOnWorktreeDelete: false,
      }),
    ).toBe("setup");
    expect(
      projectScriptLifecycleLabel({
        id: "cleanup",
        name: "Cleanup",
        command: "git pull --ff-only",
        icon: "configure",
        runOnWorktreeCreate: false,
        runOnWorktreeDelete: true,
      }),
    ).toBe("cleanup");
    expect(
      projectScriptLifecycleLabel({
        id: "both",
        name: "Both",
        command: "echo done",
        icon: "play",
        runOnWorktreeCreate: true,
        runOnWorktreeDelete: true,
      }),
    ).toBe("setup, cleanup");
  });

  it("enforces one create hook and one delete hook while allowing both on one action", () => {
    const scripts = [
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure" as const,
        runOnWorktreeCreate: true,
        runOnWorktreeDelete: false,
      },
      {
        id: "cleanup",
        name: "Cleanup",
        command: "git pull --ff-only",
        icon: "configure" as const,
        runOnWorktreeCreate: false,
        runOnWorktreeDelete: true,
      },
    ];

    const nextScripts = upsertProjectScript(scripts, {
      id: "all-hooks",
      name: "All hooks",
      command: "echo hooks",
      icon: "play",
      runOnWorktreeCreate: true,
      runOnWorktreeDelete: true,
    });

    expect(nextScripts).toEqual([
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: false,
        runOnWorktreeDelete: false,
      },
      {
        id: "cleanup",
        name: "Cleanup",
        command: "git pull --ff-only",
        icon: "configure",
        runOnWorktreeCreate: false,
        runOnWorktreeDelete: false,
      },
      {
        id: "all-hooks",
        name: "All hooks",
        command: "echo hooks",
        icon: "play",
        runOnWorktreeCreate: true,
        runOnWorktreeDelete: true,
      },
    ]);
  });

  it("only clears conflicting lifecycle slots on update", () => {
    const scripts = [
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure" as const,
        runOnWorktreeCreate: true,
        runOnWorktreeDelete: false,
      },
      {
        id: "cleanup",
        name: "Cleanup",
        command: "git pull --ff-only",
        icon: "configure" as const,
        runOnWorktreeCreate: false,
        runOnWorktreeDelete: true,
      },
    ];

    const nextScripts = upsertProjectScript(scripts, {
      id: "setup",
      name: "Setup",
      command: "bun install --frozen-lockfile",
      icon: "configure",
      runOnWorktreeCreate: true,
      runOnWorktreeDelete: true,
    });

    expect(nextScripts).toEqual([
      {
        id: "setup",
        name: "Setup",
        command: "bun install --frozen-lockfile",
        icon: "configure",
        runOnWorktreeCreate: true,
        runOnWorktreeDelete: true,
      },
      {
        id: "cleanup",
        name: "Cleanup",
        command: "git pull --ff-only",
        icon: "configure",
        runOnWorktreeCreate: false,
        runOnWorktreeDelete: false,
      },
    ]);
  });

  it("builds default runtime env for scripts", () => {
    const env = projectScriptRuntimeEnv({
      project: { cwd: "/repo" },
      worktreePath: "/repo/worktree-a",
    });

    expect(env).toMatchObject({
      T3CODE_PROJECT_ROOT: "/repo",
      T3CODE_WORKTREE_PATH: "/repo/worktree-a",
    });
  });

  it("allows overriding runtime env values", () => {
    const env = projectScriptRuntimeEnv({
      project: { cwd: "/repo" },
      extraEnv: {
        T3CODE_PROJECT_ROOT: "/custom-root",
        CUSTOM_FLAG: "1",
      },
    });

    expect(env.T3CODE_PROJECT_ROOT).toBe("/custom-root");
    expect(env.CUSTOM_FLAG).toBe("1");
    expect(env.T3CODE_WORKTREE_PATH).toBeUndefined();
  });
});
