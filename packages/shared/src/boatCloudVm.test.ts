// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import {
  ADD_PROJECT_SCRIPT,
  baseBranchCheckScript,
  boatCloudProviderDrivers,
  cloneRepositoriesScript,
  idleSecondsOf,
  parkCheckoutFunction,
  parseMeasure,
  parseRepository,
  pickMachine,
  prepareWorktreeScript,
  subdomainOfHttpBaseUrl,
  syncCheckoutScript,
} from "./boatCloudVm.ts";

describe("parseRepository", () => {
  it("gives every remote form of one repository the same key and an HTTPS clone URL", () => {
    const forms = [
      "git@github.com:PingDotGG/t3code.git",
      "ssh://git@github.com/pingdotgg/t3code.git",
      "https://github.com/pingdotgg/t3code",
      "https://user@github.com/pingdotgg/t3code.git/",
    ];
    for (const form of forms) {
      const parsed = parseRepository(form);
      assert.strictEqual(parsed?.key, "github.com/pingdotgg/t3code", form);
    }
    assert.deepStrictEqual(parseRepository("git@github.com:pingdotgg/t3code.git"), {
      key: "github.com/pingdotgg/t3code",
      name: "pingdotgg/t3code",
      cloneUrl: "https://github.com/pingdotgg/t3code.git",
      workspaceRoot: "/home/user/projects/github.com/pingdotgg/t3code",
    });
  });

  it("gives repositories on other hosts or namespaces their own checkout, and rejects what cannot be cloned", () => {
    const roots = [
      "https://github.com/acme/app.git",
      "https://gitlab.com/acme/app.git",
      "https://gitlab.com/acme/tools/app.git",
      "https://gitlab.com/acme-tools/app.git",
    ].map((remote) => parseRepository(remote)?.workspaceRoot);
    assert.deepStrictEqual(roots, [
      "/home/user/projects/github.com/acme/app",
      "/home/user/projects/gitlab.com/acme/app",
      "/home/user/projects/gitlab.com/acme/tools/app",
      "/home/user/projects/gitlab.com/acme-tools/app",
    ]);
    assert.isNull(parseRepository("/home/me/local-repo"));
    assert.isNull(parseRepository("file:///home/me/repo"));
    assert.isNull(parseRepository("https://github.com/only-owner"));
  });
});

describe("parseMeasure", () => {
  it("takes the larger of CPU waiting and memory use and lists the VM's checkouts", () => {
    assert.deepStrictEqual(
      parseMeasure("0.25 1000 900\n/home/user/projects/acme/app\n/home/user/projects/a/b\n"),
      {
        usage: 0.25,
        workspaceRoots: ["/home/user/projects/acme/app", "/home/user/projects/a/b"],
      },
    );
    assert.strictEqual(parseMeasure("0.025 1000 300")?.usage, 0.7);
    assert.isNull(parseMeasure("garbage"));
    assert.isNull(parseMeasure("0.1 0 900"));
  });
});

describe("pickMachine", () => {
  const root = "/home/user/projects/acme/app";
  const vm = (
    sandboxId: string,
    running: boolean,
    usage: number | null,
    workspaceRoots: ReadonlyArray<string> = [],
    environment: string | null = "base",
    spare = false,
  ) => ({ sandboxId, environment, running, usage, workspaceRoots, spare });

  it("reuses a running VM under half load, preferring one that has the checkout", () => {
    assert.deepStrictEqual(
      pickMachine([vm("idle", true, 0.1), vm("has-repo", true, 0.4, [root])], root, "base"),
      { kind: "use", sandboxId: "has-repo" },
    );
    assert.deepStrictEqual(pickMachine([vm("b", true, 0.3), vm("a", true, 0.1)], root, null), {
      kind: "use",
      sandboxId: "a",
    });
  });

  it("resumes before creating, and never shares a busy or silent VM", () => {
    assert.deepStrictEqual(
      pickMachine(
        [vm("busy", true, 0.5, [root]), vm("silent", true, null), vm("off", false, null)],
        root,
        "base",
      ),
      { kind: "resume", sandboxId: "off" },
    );
    assert.deepStrictEqual(
      pickMachine([vm("off-with-repo", false, null, [root]), vm("off", false, null)], root, "base"),
      { kind: "resume", sandboxId: "off-with-repo" },
    );
    assert.deepStrictEqual(pickMachine([vm("busy", true, 0.9)], root, "base"), {
      kind: "create",
    });
  });

  it("uses a running VM before waking a stopped one that has the checkout", () => {
    assert.deepStrictEqual(
      pickMachine([vm("off-with-repo", false, null, [root]), vm("free", true, 0.2)], root, "base"),
      { kind: "use", sandboxId: "free" },
    );
    const spare = vm("spare", true, 0, [], "base", true);
    assert.deepStrictEqual(
      pickMachine([vm("off-with-repo", false, null, [root]), spare], root, "base"),
      {
        kind: "use",
        sandboxId: "spare",
      },
    );
  });

  it("takes the spare only after the VMs of its kind", () => {
    const spare = vm("spare", true, 0, [root], "base", true);
    assert.deepStrictEqual(pickMachine([spare, vm("free", true, 0.3, [root])], root, "base"), {
      kind: "use",
      sandboxId: "free",
    });
    assert.deepStrictEqual(pickMachine([spare, vm("off", false, null, [root])], root, "base"), {
      kind: "use",
      sandboxId: "spare",
    });
    assert.deepStrictEqual(pickMachine([spare, vm("free", true, 0.1)], root, "base"), {
      kind: "use",
      sandboxId: "spare",
    });
  });

  it("only joins a VM on the chosen environment", () => {
    const others = [
      vm("other-free", true, 0.1, [root], "staging"),
      vm("other-off", false, null, [root], "staging"),
      vm("unattached", true, 0.1, [root], null),
    ];
    assert.deepStrictEqual(pickMachine(others, root, "base"), { kind: "create" });
    assert.deepStrictEqual(pickMachine([...others, vm("mine", false, null)], root, "base"), {
      kind: "resume",
      sandboxId: "mine",
    });
  });
});

describe("idleSecondsOf", () => {
  it("counts from the later of the last turn and the hand-out, and never while a turn runs", () => {
    assert.strictEqual(idleSecondsOf("0 700\n", 900), 700);
    assert.strictEqual(idleSecondsOf("0 700", 120), 120);
    assert.strictEqual(idleSecondsOf("0 \n", 300), 300);
    assert.isNull(idleSecondsOf("2 0", 900));
    assert.isNull(idleSecondsOf("", 900));
  });
});

describe("boatCloudProviderDrivers", () => {
  it("offers each provider one of Boat's credentials signs in", () => {
    assert.deepStrictEqual(
      [...boatCloudProviderDrivers(["anthropic-api-key", "opencode-api-key"])].toSorted(),
      ["claudeAgent", "opencode", "pi"],
    );
    assert.deepStrictEqual([...boatCloudProviderDrivers(["chatgpt-subscription"])], ["codex"]);
    assert.strictEqual(boatCloudProviderDrivers([]).size, 0);
  });
});

describe("subdomainOfHttpBaseUrl", () => {
  it("finds the VM behind its hosted T3 URL and ignores other hosts", () => {
    assert.strictEqual(
      subdomainOfHttpBaseUrl("https://box-node-1dca660d802d15b6-3773.on.boat.dev"),
      "box-node-1dca660d802d15b6",
    );
    assert.isNull(subdomainOfHttpBaseUrl("https://box-node-1dca-8080.on.boat.dev"));
    assert.isNull(subdomainOfHttpBaseUrl("https://example.com"));
  });
});

describe("baseBranchCheckScript", () => {
  it("passes for a pushed branch, local or remote-named, and names an unpushed one", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "boat-base-branch-"));
    using _cleanup = {
      [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
    };
    const git = (...args: string[]) =>
      NodeChildProcess.spawnSync("git", ["-c", "init.defaultBranch=main", ...args], { cwd: root });
    git("init", "--quiet", "source");
    git(
      "-C",
      "source",
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "base",
    );
    git("-C", "source", "branch", "feat/pushed");
    git("clone", "--quiet", "source", "clone");
    const check = (branch: string) =>
      NodeChildProcess.spawnSync("bash", [
        "-c",
        `dir=${NodePath.join(root, "clone")}\n${baseBranchCheckScript(branch, "me/repo")}`,
      ]);

    assert.strictEqual(check("feat/pushed").status, 0);
    assert.strictEqual(check("origin/main").status, 0);
    const missing = check("feat/local-only");
    assert.strictEqual(missing.status, 3);
    assert.include(missing.stderr.toString(), "feat/local-only is not on me/repo.");
  });
});

describe("syncCheckoutScript", () => {
  it("clones once, then fetches only for a base branch the checkout does not know", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "boat-checkout-"));
    using _cleanup = {
      [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
    };
    const git = (...args: string[]) =>
      NodeChildProcess.spawnSync(
        "git",
        ["-c", "init.defaultBranch=main", "-c", "user.name=t", "-c", "user.email=t@t", ...args],
        { cwd: root },
      );
    git("init", "--quiet", "source");
    git("-C", "source", "commit", "--quiet", "--allow-empty", "-m", "base");
    const sync = (baseBranch: string | null) =>
      NodeChildProcess.spawnSync("bash", [
        "-c",
        syncCheckoutScript(
          {
            key: "local/me/repo",
            name: "me/repo",
            cloneUrl: NodePath.join(root, "source"),
            workspaceRoot: NodePath.join(root, "projects", "repo"),
          },
          baseBranch,
        ),
      ]);

    assert.strictEqual(sync("main").status, 0);
    git("-C", "source", "branch", "feat/later");
    assert.strictEqual(sync("feat/later").status, 0);
    // A fetch would fail now, so a known base must not reach the remote.
    git("-C", "projects/repo", "remote", "set-url", "origin", NodePath.join(root, "gone"));
    assert.strictEqual(sync("feat/later").status, 0);
    assert.strictEqual(sync(null).status, 0);
    assert.notStrictEqual(sync("feat/never").status, 0);
  });
});

describe("ADD_PROJECT_SCRIPT", () => {
  it("adds the checkout once the server answers, on a VM with no database yet", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "boat-add-project-"));
    using _cleanup = {
      [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
    };
    const stub = (name: string, body: string) =>
      NodeFS.writeFileSync(NodePath.join(root, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    stub("sqlite3", "exit 1");
    stub("curl", "echo '{}'");
    stub("t3", `echo "$@" > ${NodePath.join(root, "added")}`);
    const result = NodeChildProcess.spawnSync(
      "bash",
      ["-c", `set -e\ndir=/repo\nT3=${NodePath.join(root, "t3")}\n${ADD_PROJECT_SCRIPT}`],
      { env: { ...process.env, PATH: `${root}:${process.env.PATH}` } },
    );

    assert.strictEqual(result.status, 0, result.stderr.toString());
    assert.strictEqual(
      NodeFS.readFileSync(NodePath.join(root, "added"), "utf8").trim(),
      "project add /repo",
    );
  });
});

describe("prepareWorktreeScript", () => {
  it("cuts the branch from the remote's latest base and records that base", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "boat-worktree-"));
    using _cleanup = {
      [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
    };
    const git = (...args: string[]) =>
      NodeChildProcess.spawnSync(
        "git",
        ["-c", "init.defaultBranch=main", "-c", "user.name=t", "-c", "user.email=t@t", ...args],
        { cwd: root },
      )
        .stdout.toString()
        .trim();
    git("init", "--quiet", "source");
    git("-C", "source", "commit", "--quiet", "--allow-empty", "-m", "base");
    git("clone", "--quiet", "source", "clone");
    // The snapshot's checkout is older than the remote.
    git("-C", "source", "commit", "--quiet", "--allow-empty", "-m", "later");
    const path = NodePath.join(root, "worktrees", "t3-0a1b2c3d");
    const parked = NodePath.join(root, "parked", "repo");
    const result = NodeChildProcess.spawnSync("bash", [
      "-c",
      `set -e\ndir=${NodePath.join(root, "clone")}\n${prepareWorktreeScript({ path, branch: "t3/0a1b2c3d", baseBranch: "main" }, parked)}`,
    ]);

    assert.strictEqual(result.status, 0, result.stderr.toString());
    assert.strictEqual(
      git("-C", path, "rev-parse", "HEAD"),
      git("-C", "source", "rev-parse", "main"),
    );
    assert.strictEqual(git("-C", path, "branch", "--show-current"), "t3/0a1b2c3d");
    assert.strictEqual(git("-C", "clone", "config", "branch.t3/0a1b2c3d.t3-merge-base"), "main");
  });

  it("moves a worktree parked on the base into place and brings it to the latest base", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "boat-parked-"));
    using _cleanup = {
      [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
    };
    const git = (...args: string[]) =>
      NodeChildProcess.spawnSync(
        "git",
        ["-c", "init.defaultBranch=main", "-c", "user.name=t", "-c", "user.email=t@t", ...args],
        { cwd: root },
      )
        .stdout.toString()
        .trim();
    git("init", "--quiet", "source");
    NodeFS.writeFileSync(NodePath.join(root, "source", "file"), "base\n");
    git("-C", "source", "add", "file");
    git("-C", "source", "commit", "--quiet", "-m", "base");
    git("clone", "--quiet", "source", "clone");
    const dir = NodePath.join(root, "clone");
    const parked = NodePath.join(root, "parked", "repo");
    const bash = (script: string) => NodeChildProcess.spawnSync("bash", ["-c", script]);
    const park = bash(`${parkCheckoutFunction}\npark_checkout ${dir} ${parked}`);
    assert.strictEqual(park.status, 0, park.stderr.toString());
    assert.isTrue(NodeFS.existsSync(NodePath.join(parked, "file")));

    // The remote moved on after the VM parked its worktree.
    NodeFS.writeFileSync(NodePath.join(root, "source", "file"), "later\n");
    git("-C", "source", "commit", "--quiet", "-am", "later");
    const path = NodePath.join(root, "worktrees", "t3-0a1b2c3d");
    const result = bash(
      `set -e\ndir=${dir}\n${prepareWorktreeScript({ path, branch: "t3/0a1b2c3d", baseBranch: "main" }, parked)}`,
    );

    assert.strictEqual(result.status, 0, result.stderr.toString());
    assert.isFalse(NodeFS.existsSync(parked));
    assert.strictEqual(NodeFS.readFileSync(NodePath.join(path, "file"), "utf8"), "later\n");
    assert.strictEqual(git("-C", path, "branch", "--show-current"), "t3/0a1b2c3d");
    assert.strictEqual(git("-C", "clone", "config", "branch.t3/0a1b2c3d.t3-merge-base"), "main");
    assert.strictEqual(git("-C", "clone", "config", "branch.t3/0a1b2c3d.t3-boat-parked-base"), "");
    // A second thread finds nothing parked and checks out its own worktree.
    const second = NodePath.join(root, "worktrees", "t3-0b1b2c3d");
    const next = bash(
      `set -e\ndir=${dir}\n${prepareWorktreeScript({ path: second, branch: "t3/0b1b2c3d", baseBranch: "main" }, parked)}`,
    );
    assert.strictEqual(next.status, 0, next.stderr.toString());
    assert.strictEqual(NodeFS.readFileSync(NodePath.join(second, "file"), "utf8"), "later\n");
  });
});

describe("cloneRepositoriesScript", () => {
  it("prints the clones that finished and leaves nothing of one that failed", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "boat-snapshot-clone-"));
    using _cleanup = {
      [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
    };
    NodeChildProcess.spawnSync(
      "git",
      ["-c", "init.defaultBranch=main", "init", "--quiet", "source"],
      {
        cwd: root,
      },
    );
    const repository = (name: string, source: string) => ({
      key: `local/me/${name}`,
      name: `me/${name}`,
      cloneUrl: NodePath.join(root, source),
      workspaceRoot: NodePath.join(root, "projects", "me", name),
    });
    const cloned = NodeChildProcess.spawnSync("bash", [
      "-c",
      cloneRepositoriesScript([repository("app", "source"), repository("gone", "missing")]),
    ]);

    assert.strictEqual(cloned.status, 0);
    assert.strictEqual(
      cloned.stdout.toString(),
      `${NodePath.join(root, "projects", "me", "app")}\n`,
    );
    assert.isTrue(NodeFS.existsSync(NodePath.join(root, "projects", "me", "app", ".git")));
    assert.deepStrictEqual(NodeFS.readdirSync(NodePath.join(root, "projects", "me")), ["app"]);
  });
});
