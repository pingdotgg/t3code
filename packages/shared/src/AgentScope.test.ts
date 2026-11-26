// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { AGENT_OOM_SCORE_ADJ, agentScopeCommand, agentScopeLauncherScript } from "./AgentScope.ts";
import * as HostProcess from "./HostProcess.ts";

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("agentScopeCommand", () => {
  it("raises the OOM score and execs the command with its arguments in the same process", () => {
    const launch = agentScopeCommand({
      command: "/bin/sh",
      args: [
        "-c",
        'printf "%s\\n" "$$" "$(cat /proc/self/oom_score_adj)" "$@"',
        "agent",
        "a b",
        "$HOME",
      ],
    });
    const child = NodeChildProcess.spawnSync(launch.command, [...launch.args], {
      encoding: "utf8",
    });
    const [pid, score, ...args] = child.stdout.trimEnd().split("\n");
    expect(Number(pid)).toBe(child.pid);
    expect(Number(score)).toBe(AGENT_OOM_SCORE_ADJ);
    expect(args).toEqual(["a b", "$HOME"]);

    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-agent-launcher-"));
    try {
      const launcher = NodePath.join(directory, "launch's");
      NodeFS.writeFileSync(launcher, agentScopeLauncherScript(launch), { mode: 0o700 });
      const launched = NodeChildProcess.spawnSync(launcher, ["--flag", "it's"], {
        encoding: "utf8",
      });
      const [launchedPid, launchedScore, ...launchedArgs] = launched.stdout.trimEnd().split("\n");
      expect(Number(launchedPid)).toBe(launched.pid);
      expect(Number(launchedScore)).toBe(AGENT_OOM_SCORE_ADJ);
      expect(launchedArgs).toEqual(["a b", "$HOME", "--flag", "it's"]);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("executes a launcher script via a custom resolved shell shebang", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sh-"));
    try {
      const customShell = NodePath.join(directory, "sh");
      NodeFS.symlinkSync("/bin/sh", customShell);
      const launch = agentScopeCommand({
        command: customShell,
        args: ["-c", 'printf "%s\\n" "$$" "$(cat /proc/self/oom_score_adj)" "$@"', "agent", "a b"],
        shell: customShell,
      });
      const script = agentScopeLauncherScript(launch);
      expect(script.split("\n")[0]).toBe(`#!${customShell}`);

      const launcher = NodePath.join(directory, "launch");
      NodeFS.writeFileSync(launcher, script, { mode: 0o700 });
      const launched = NodeChildProcess.spawnSync(launcher, ["--flag"], { encoding: "utf8" });
      const [launchedPid, launchedScore, ...launchedArgs] = launched.stdout.trimEnd().split("\n");
      expect(Number(launchedPid)).toBe(launched.pid);
      expect(Number(launchedScore)).toBe(AGENT_OOM_SCORE_ADJ);
      expect(launchedArgs).toEqual(["a b", "--flag"]);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("agentScopeLauncherScript", () => {
  it("uses the resolved shell in the shebang and falls back to /bin/sh when unsafe", () => {
    const termuxShell = "/data/data/com.termux/files/usr/bin/sh";
    const unscoped = agentScopeLauncherScript(
      agentScopeCommand({
        command: "/data/data/com.termux/files/usr/bin/chromium",
        args: [],
        shell: termuxShell,
      }),
    );
    expect(unscoped.split("\n")[0]).toBe(`#!${termuxShell}`);

    const scoped = agentScopeLauncherScript(
      agentScopeCommand({
        command: "/data/data/com.termux/files/usr/bin/chromium",
        args: [],
        shell: termuxShell,
        scope: {
          systemdRun: "/data/data/com.termux/files/usr/bin/systemd-run",
          slice: "app.slice",
          unit: "preview.scope",
          runtimeDir: "/run/user/1000",
          options: [],
        },
      }),
    );
    expect(scoped.split("\n")[0]).toBe(`#!${termuxShell}`);

    for (const unsafeShell of ["/custom dir/sh", "/custom/sh\necho bad", "sh", ""]) {
      const script = agentScopeLauncherScript(
        agentScopeCommand({ command: "/usr/bin/chromium", args: [], shell: unsafeShell }),
      );
      expect(script.split("\n")[0]).toBe("#!/bin/sh");
    }

    expect(
      agentScopeLauncherScript({ command: "/usr/bin/chromium", args: ["--headless"] }).split(
        "\n",
      )[0],
    ).toBe("#!/bin/sh");
  });
});
