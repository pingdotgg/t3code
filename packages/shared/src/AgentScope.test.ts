// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { agentScopeCommand, agentScopeLauncherScript } from "./AgentScope.ts";
import * as HostProcess from "./HostProcess.ts";

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("agentScopeCommand", () => {
  it("keeps the inherited OOM score and execs the command with its arguments in the same process", () => {
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
    // Raising is always permitted, so 801 is a known inherited score on any host.
    const inheritScore = (command: string, args: ReadonlyArray<string>) =>
      NodeChildProcess.spawnSync(
        "/bin/sh",
        ["-c", 'echo 801 >/proc/self/oom_score_adj && exec "$@"', "parent", command, ...args],
        { encoding: "utf8" },
      );
    const child = inheritScore(launch.command, launch.args);
    const [pid, score, ...args] = child.stdout.trimEnd().split("\n");
    expect(Number(pid)).toBe(child.pid);
    expect(Number(score)).toBe(801);
    expect(args).toEqual(["a b", "$HOME"]);

    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-agent-launcher-"));
    try {
      const launcher = NodePath.join(directory, "launch's");
      NodeFS.writeFileSync(launcher, agentScopeLauncherScript(launch), { mode: 0o700 });
      const launched = inheritScore(launcher, ["--flag", "it's"]);
      const [launchedPid, launchedScore, ...launchedArgs] = launched.stdout.trimEnd().split("\n");
      expect(Number(launchedPid)).toBe(launched.pid);
      expect(Number(launchedScore)).toBe(801);
      expect(launchedArgs).toEqual(["a b", "$HOME", "--flag", "it's"]);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
