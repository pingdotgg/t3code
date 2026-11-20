import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { ensurePstack } from "./pstack";
import { createLinuxHost, type ProcessRunner } from "./wslEngine";

/** A Linux host that runs the script with `sh` in a temporary HOME, and whose `git` clone source is a local repo. */
function hostIn(home: string, remote: string) {
  const runner: ProcessRunner = {
    run: async (_command, _args, options) => {
      const script = (options.stdin ?? "").replaceAll(
        "https://github.com/13kparkin/pstack-t3",
        remote,
      );
      const result = NodeChildProcess.spawnSync("sh", ["-s"], {
        input: script,
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      });
      return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
    },
    start: () => {
      throw new Error("unused");
    },
  };
  return createLinuxHost({ platform: "linux", distro: null, runner });
}

const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8" },
  ).trim();

function makeRemote(root: string) {
  const remote = NodePath.join(root, "remote");
  NodeFS.mkdirSync(NodePath.join(remote, "skills", "how"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(remote, "skills", "how", "SKILL.md"), "v1\n");
  git(remote, "init", "-q", "-b", "main");
  git(remote, "add", ".");
  git(remote, "commit", "-q", "-m", "v1");
  return remote;
}

describe("ensurePstack", () => {
  it("Given no checkout, when it runs, then it clones into the board's folder and returns that folder", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pstack-test-"));
    try {
      const home = NodePath.join(root, "home");
      NodeFS.mkdirSync(home);
      const remote = makeRemote(root);

      const result = await ensurePstack(hostIn(home, remote));

      expect(result).toEqual({ ok: true, dir: `${home}/.agent-board/pstack-t3` });
      expect(
        NodeFS.readFileSync(`${home}/.agent-board/pstack-t3/skills/how/SKILL.md`, "utf8"),
      ).toBe("v1\n");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("Given a checkout and a newer remote commit, when it runs again, then the checkout moves to it", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pstack-test-"));
    try {
      const home = NodePath.join(root, "home");
      NodeFS.mkdirSync(home);
      const remote = makeRemote(root);
      const host = hostIn(home, remote);
      await ensurePstack(host);
      NodeFS.writeFileSync(NodePath.join(remote, "skills", "how", "SKILL.md"), "v2\n");
      git(remote, "commit", "-q", "-am", "v2");

      const result = await ensurePstack(host);

      expect(result.ok).toBe(true);
      expect(
        NodeFS.readFileSync(`${home}/.agent-board/pstack-t3/skills/how/SKILL.md`, "utf8"),
      ).toBe("v2\n");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("Given a checkout and an unreachable remote, when it runs, then the checkout stays and is returned", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pstack-test-"));
    try {
      const home = NodePath.join(root, "home");
      NodeFS.mkdirSync(home);
      const remote = makeRemote(root);
      await ensurePstack(hostIn(home, remote));
      NodeFS.rmSync(remote, { recursive: true });

      const result = await ensurePstack(hostIn(home, remote));

      expect(result).toEqual({ ok: true, dir: `${home}/.agent-board/pstack-t3` });
      expect(
        NodeFS.readFileSync(`${home}/.agent-board/pstack-t3/skills/how/SKILL.md`, "utf8"),
      ).toBe("v1\n");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("Given no checkout and an unreachable remote, when it runs, then it reports why", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pstack-test-"));
    try {
      const home = NodePath.join(root, "home");
      NodeFS.mkdirSync(home);

      const result = await ensurePstack(hostIn(home, NodePath.join(root, "missing")));

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toContain("could not be fetched");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
