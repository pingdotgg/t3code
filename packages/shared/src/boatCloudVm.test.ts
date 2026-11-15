// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import {
  baseBranchCheckScript,
  boatCloudProviderDrivers,
  idleSecondsOf,
  parseMeasure,
  parseRepository,
  pickMachine,
  subdomainOfHttpBaseUrl,
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
  it("takes the larger of CPU and memory use and lists the VM's checkouts", () => {
    assert.deepStrictEqual(
      parseMeasure("1.00 4 1000 900\n/home/user/projects/acme/app\n/home/user/projects/a/b\n"),
      {
        usage: 0.25,
        workspaceRoots: ["/home/user/projects/acme/app", "/home/user/projects/a/b"],
      },
    );
    assert.strictEqual(parseMeasure("0.10 4 1000 300")?.usage, 0.7);
    assert.isNull(parseMeasure("garbage"));
    assert.isNull(parseMeasure("1 0 1000 900"));
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
  ) => ({ sandboxId, environment, running, usage, workspaceRoots });

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
      pickMachine([vm("free", true, 0.2), vm("off-with-repo", false, null, [root])], root, "base"),
      { kind: "resume", sandboxId: "off-with-repo" },
    );
    assert.deepStrictEqual(pickMachine([vm("busy", true, 0.9)], root, "base"), {
      kind: "create",
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
