import { describe, expect, it } from "vite-plus/test";

import {
  dockerExecArgs,
  preferredSandboxHostPort,
  sandboxContainerName,
  sandboxEnvNames,
} from "./sandboxDocker.ts";

describe("sandboxEnvNames", () => {
  const hostEnv = {
    PATH: "/usr/local/bin:/usr/bin",
    HOME: "/Users/theo",
    XDG_RUNTIME_DIR: "/run/user/501",
    EDITOR: "vim",
    ANTHROPIC_API_KEY: "sk-host",
    LANG: "en_US.UTF-8",
  };

  it("passes overrides and inherited credentials but not host plumbing", () => {
    const names = sandboxEnvNames(
      {
        ...hostEnv,
        PATH: "/managed/bin:/usr/local/bin:/usr/bin",
        CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
        T3_THREAD: "thread-1",
      },
      hostEnv,
    );
    expect(names).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CODE_ENTRYPOINT", "LANG", "T3_THREAD"]);
  });

  it("skips unset values", () => {
    expect(sandboxEnvNames({ OPENAI_API_KEY: undefined }, {})).toEqual([]);
  });
});

describe("dockerExecArgs", () => {
  it("names env vars without their values and records the command's pid", () => {
    const args = dockerExecArgs({
      containerName: "t3code-sandbox-x",
      execId: "exec-1",
      cwd: "/work/tree",
      envNames: ["ANTHROPIC_API_KEY"],
      tty: false,
      command: "claude",
      args: ["--output-format", "stream-json"],
    });
    expect(args).toEqual([
      "exec",
      "-i",
      "-w",
      "/work/tree",
      "-e",
      "ANTHROPIC_API_KEY",
      "t3code-sandbox-x",
      "/bin/sh",
      "-c",
      'mkdir -p /tmp/.t3-exec && echo "$$ $(cut -d" " -f22 /proc/$$/stat)" > "/tmp/.t3-exec/$0" && exec "$@"',
      "exec-1",
      "claude",
      "--output-format",
      "stream-json",
    ]);
  });
});

describe("sandbox names", () => {
  it("derives a stable, Docker-safe container name per worktree", () => {
    const name = sandboxContainerName("/Users/theo/.t3/worktrees/t3code/Feature Branch!");
    expect(name).toMatch(/^t3code-sandbox-feature-branch-[0-9a-f]{8}$/);
    expect(sandboxContainerName("/Users/theo/.t3/worktrees/t3code/Feature Branch!")).toBe(name);
    expect(sandboxContainerName("/other/Feature Branch!")).not.toBe(name);
  });

  it("keeps preferred host ports in a fixed range", () => {
    const port = preferredSandboxHostPort("t3code-sandbox-x", 3000);
    expect(port).toBeGreaterThanOrEqual(42000);
    expect(port).toBeLessThan(50000);
    expect(preferredSandboxHostPort("t3code-sandbox-x", 3000)).toBe(port);
  });
});
