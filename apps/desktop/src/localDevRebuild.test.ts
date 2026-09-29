import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";
import type { DesktopLocalRebuildLifecycle } from "@t3tools/contracts";

import {
  checkLocalDevRebuildStaleness,
  decideRebuildStaleness,
  launchLocalDevRebuild,
  parseLsRemoteSymrefHead,
  persistLocalDevRebuildLifecycle,
  pullLatestCheckoutChanges,
  readEmbeddedDevSourceRoot,
  restoreLocalDevRebuildLifecycle,
  resolveLocalDevRebuildState,
  runLocalRebuildStart,
  type GitRunner,
  type LocalRebuildStartDeps,
} from "./localDevRebuild.ts";

function makeCheckout(): string {
  const sourceRoot = FS.mkdtempSync(Path.join(OS.tmpdir(), "t3code-rebuild-"));
  FS.mkdirSync(Path.join(sourceRoot, "scripts"));
  FS.writeFileSync(
    Path.join(sourceRoot, "package.json"),
    JSON.stringify({ name: "@t3tools/monorepo" }),
  );
  FS.writeFileSync(Path.join(sourceRoot, "scripts", "install-t3-dev.sh"), "#!/bin/bash\n");
  return sourceRoot;
}

describe("local Dev rebuild", () => {
  it("reads the source root embedded in packaged metadata", () => {
    const appRoot = FS.mkdtempSync(Path.join(OS.tmpdir(), "t3code-app-"));
    FS.writeFileSync(
      Path.join(appRoot, "package.json"),
      JSON.stringify({ t3codeDevSourceRoot: "/tmp/t3code" }),
    );

    expect(readEmbeddedDevSourceRoot(appRoot)).toBe("/tmp/t3code");
  });

  it("enables rebuilds only for a valid packaged macOS Dev checkout", () => {
    const sourceRoot = makeCheckout();

    expect(
      resolveLocalDevRebuildState({
        isPackaged: true,
        isDevAppFlavor: true,
        platform: "darwin",
        sourceRoot,
      }),
    ).toEqual({ enabled: true, sourceRoot: FS.realpathSync(sourceRoot), reason: null });

    expect(
      resolveLocalDevRebuildState({
        isPackaged: true,
        isDevAppFlavor: false,
        platform: "darwin",
        sourceRoot,
      }).enabled,
    ).toBe(false);
  });

  it("launches the fixed installer as a detached process after spawn succeeds", async () => {
    const sourceRoot = makeCheckout();
    const logDirectory = FS.mkdtempSync(Path.join(OS.tmpdir(), "t3code-rebuild-log-"));
    const unref = vi.fn();
    const child = Object.assign(new EventEmitter(), { unref });
    const spawn = vi.fn(() => child);

    const resultPromise = launchLocalDevRebuild(
      { enabled: true, sourceRoot, reason: null },
      logDirectory,
      spawn as unknown as typeof import("node:child_process").spawn,
    );
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    child.emit("spawn");
    const result = await resultPromise;

    expect(result.accepted).toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      "/bin/bash",
      [Path.join(sourceRoot, "scripts", "install-t3-dev.sh")],
      expect.objectContaining({
        cwd: sourceRoot,
        detached: true,
        env: expect.objectContaining({
          T3CODE_DEV_REBUILD_LOG_PATH: Path.join(logDirectory, "dev-rebuild.log"),
        }),
        stdio: "ignore",
      }),
    );
    expect(unref).toHaveBeenCalledOnce();
  });

  it("rejects a missing checkout and reports synchronous launch failures", async () => {
    expect(
      resolveLocalDevRebuildState({
        isPackaged: true,
        isDevAppFlavor: true,
        platform: "darwin",
        sourceRoot: "/missing/t3code-checkout",
      }).enabled,
    ).toBe(false);

    const sourceRoot = makeCheckout();
    const logDirectory = FS.mkdtempSync(Path.join(OS.tmpdir(), "t3code-rebuild-log-"));
    const result = await launchLocalDevRebuild(
      { enabled: true, sourceRoot, reason: null },
      logDirectory,
      vi.fn(() => {
        throw new Error("spawn failed");
      }) as unknown as typeof import("node:child_process").spawn,
    );

    expect(result).toEqual({
      accepted: false,
      logPath: Path.join(logDirectory, "dev-rebuild.log"),
      message: "spawn failed",
    });
  });

  it("reports asynchronous launch failures and notifies when the child exits", async () => {
    const sourceRoot = makeCheckout();
    const logDirectory = FS.mkdtempSync(Path.join(OS.tmpdir(), "t3code-rebuild-log-"));
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const onExit = vi.fn();
    const resultPromise = launchLocalDevRebuild(
      { enabled: true, sourceRoot, reason: null },
      logDirectory,
      vi.fn(() => child) as unknown as typeof import("node:child_process").spawn,
      onExit,
    );

    child.emit("error", new Error("async spawn failed"));

    await expect(resultPromise).resolves.toEqual({
      accepted: false,
      logPath: Path.join(logDirectory, "dev-rebuild.log"),
      message: "async spawn failed",
    });
    child.emit("exit", 1, null);
    expect(onExit).toHaveBeenCalledOnce();
    expect(onExit).toHaveBeenCalledWith(1, null);
  });

  it("restores installer failures and completions after an app relaunch", () => {
    const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "t3code-rebuild-state-"));
    const statePath = Path.join(root, "lifecycle.json");
    const logPath = Path.join(root, "dev-rebuild.log");
    const running: DesktopLocalRebuildLifecycle = {
      revision: 7,
      phase: "running",
      logPath,
      message: null,
    };
    try {
      persistLocalDevRebuildLifecycle(statePath, running, process.pid);
      FS.writeFileSync(`${logPath}.exit-code`, "19\n");
      expect(restoreLocalDevRebuildLifecycle(statePath, logPath)).toEqual({
        lifecycle: {
          revision: 8,
          phase: "failed",
          logPath,
          message: "The installer exited with code 19.",
        },
        processId: null,
        error: null,
      });

      FS.writeFileSync(`${logPath}.exit-code`, "0\n");
      expect(restoreLocalDevRebuildLifecycle(statePath, logPath)).toMatchObject({
        lifecycle: { revision: 8, phase: "completed", logPath, message: null },
        processId: null,
        error: null,
      });
    } finally {
      FS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a live installer busy across relaunch and surfaces a missing result for a dead process", () => {
    const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "t3code-rebuild-state-"));
    const statePath = Path.join(root, "lifecycle.json");
    const logPath = Path.join(root, "dev-rebuild.log");
    const running: DesktopLocalRebuildLifecycle = {
      revision: 3,
      phase: "running",
      logPath,
      message: null,
    };
    try {
      persistLocalDevRebuildLifecycle(statePath, running, process.pid);
      expect(restoreLocalDevRebuildLifecycle(statePath, logPath)).toEqual({
        lifecycle: running,
        processId: process.pid,
        error: null,
      });

      persistLocalDevRebuildLifecycle(statePath, running, Number.MAX_SAFE_INTEGER);
      expect(restoreLocalDevRebuildLifecycle(statePath, logPath)).toMatchObject({
        lifecycle: {
          revision: 4,
          phase: "failed",
          logPath,
          message: expect.stringContaining("stopped before reporting its result"),
        },
        processId: null,
        error: null,
      });
    } finally {
      FS.rmSync(root, { recursive: true, force: true });
    }
  });
});

const BUILD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const LOCAL_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const REMOTE_SHA = "cccccccccccccccccccccccccccccccccccccccc";

describe("local Dev rebuild staleness", () => {
  it("parses ls-remote symref output for the default branch tip", () => {
    expect(parseLsRemoteSymrefHead(`ref: refs/heads/main\tHEAD\n${REMOTE_SHA}\tHEAD\n`)).toEqual({
      sha: REMOTE_SHA,
      branch: "main",
    });
    expect(parseLsRemoteSymrefHead(`${REMOTE_SHA}\tHEAD\n`)).toEqual({
      sha: REMOTE_SHA,
      branch: null,
    });
    expect(parseLsRemoteSymrefHead("")).toBeNull();
    expect(parseLsRemoteSymrefHead("not-a-sha\tHEAD\n")).toBeNull();
  });

  it("decides behind only when the base is a strict ancestor of the remote tip", () => {
    expect(
      decideRebuildStaleness({
        baseSha: BUILD_SHA,
        remoteSha: BUILD_SHA,
        mergeBaseIsAncestor: true,
        behindBy: 0,
      }).behind,
    ).toBe(false);
    expect(
      decideRebuildStaleness({
        baseSha: BUILD_SHA,
        remoteSha: REMOTE_SHA,
        mergeBaseIsAncestor: true,
        behindBy: 3,
      }),
    ).toEqual({ behind: true, error: null });
    // Local ahead or diverged: rebuilding the checkout would not bring main in.
    expect(
      decideRebuildStaleness({
        baseSha: BUILD_SHA,
        remoteSha: REMOTE_SHA,
        mergeBaseIsAncestor: false,
        behindBy: null,
      }).behind,
    ).toBe(false);
    // Comparison impossible (e.g. unknown objects): never claim behind.
    expect(
      decideRebuildStaleness({
        baseSha: BUILD_SHA,
        remoteSha: REMOTE_SHA,
        mergeBaseIsAncestor: null,
        behindBy: null,
      }),
    ).toEqual({ behind: false, error: expect.any(String) });
  });

  function stubRunner(scenarios: Record<string, { stdout: string; exitCode: number }>): {
    runner: GitRunner;
    calls: Array<readonly string[]>;
  } {
    const calls: Array<readonly string[]> = [];
    const runner: GitRunner = async (args) => {
      calls.push(args);
      const key = args.join(" ");
      const hit = scenarios[key];
      if (hit) return hit;
      if (args[0] === "status") return { stdout: "", exitCode: 0 };
      if (args[0] === "fetch") return { stdout: "", exitCode: 0 };
      if (args[0] === "update-ref") return { stdout: "", exitCode: 0 };
      if (args[0] === "rev-parse" && args[1] === "--is-shallow-repository") {
        return { stdout: "false\n", exitCode: 0 };
      }
      throw new Error(`unexpected git invocation: ${key}`);
    };
    return { runner, calls };
  }

  const behindScenario = (): Record<string, { stdout: string; exitCode: number }> => ({
    "rev-parse HEAD": { stdout: `${LOCAL_SHA}\n`, exitCode: 0 },
    "branch --show-current": { stdout: "main\n", exitCode: 0 },
    "ls-remote --symref origin HEAD": {
      stdout: `ref: refs/heads/main\tHEAD\n${REMOTE_SHA}\tHEAD\n`,
      exitCode: 0,
    },
    [`merge-base --is-ancestor ${BUILD_SHA} ${REMOTE_SHA}`]: { stdout: "", exitCode: 0 },
    [`rev-list --count ${BUILD_SHA}..${REMOTE_SHA}`]: { stdout: "7\n", exitCode: 0 },
  });

  it("reports behind with a count when main moved past the running build", async () => {
    const { runner, calls } = stubRunner(behindScenario());
    const result = await checkLocalDevRebuildStaleness({
      enabled: true,
      sourceRoot: "/repo/t3code",
      buildSha: BUILD_SHA,
      runGit: runner,
    });

    expect(result).toMatchObject({
      available: true,
      behind: true,
      behindBy: 7,
      localBranch: "main",
      localSha: LOCAL_SHA,
      remoteBranch: "main",
      remoteSha: REMOTE_SHA,
      buildSha: BUILD_SHA,
      error: null,
    });
    expect(result.checkedAt).toEqual(expect.any(String));
    expect(calls[0]?.[0]).toBe("rev-parse");
  });

  it("falls back to the checkout HEAD when the build carries no commit", async () => {
    const scenario = behindScenario();
    scenario[`merge-base --is-ancestor ${BUILD_SHA} ${REMOTE_SHA}`] = {
      stdout: "",
      exitCode: 0,
    };
    const { runner } = stubRunner({
      ...scenario,
      [`merge-base --is-ancestor ${LOCAL_SHA} ${REMOTE_SHA}`]: { stdout: "", exitCode: 0 },
      [`rev-list --count ${LOCAL_SHA}..${REMOTE_SHA}`]: { stdout: "2\n", exitCode: 0 },
    });

    const result = await checkLocalDevRebuildStaleness({
      enabled: true,
      sourceRoot: "/repo/t3code",
      buildSha: null,
      runGit: runner,
    });

    expect(result).toMatchObject({ available: true, behind: true, behindBy: 2, buildSha: null });
  });

  it("reports up to date when the remote tip matches the running build", async () => {
    const { runner } = stubRunner({
      "rev-parse HEAD": { stdout: `${BUILD_SHA}\n`, exitCode: 0 },
      "branch --show-current": { stdout: "main\n", exitCode: 0 },
      "ls-remote --symref origin HEAD": {
        stdout: `ref: refs/heads/main\tHEAD\n${BUILD_SHA}\tHEAD\n`,
        exitCode: 0,
      },
    });

    const result = await checkLocalDevRebuildStaleness({
      enabled: true,
      sourceRoot: "/repo/t3code",
      buildSha: BUILD_SHA,
      runGit: runner,
    });

    expect(result).toMatchObject({ available: true, behind: false, error: null });
  });

  it("never claims behind for ahead or diverged checkouts", async () => {
    const { runner } = stubRunner({
      "rev-parse HEAD": { stdout: `${LOCAL_SHA}\n`, exitCode: 0 },
      "branch --show-current": { stdout: "feature\n", exitCode: 0 },
      "ls-remote --symref origin HEAD": {
        stdout: `ref: refs/heads/main\tHEAD\n${REMOTE_SHA}\tHEAD\n`,
        exitCode: 0,
      },
      [`merge-base --is-ancestor ${BUILD_SHA} ${REMOTE_SHA}`]: { stdout: "", exitCode: 1 },
    });

    const result = await checkLocalDevRebuildStaleness({
      enabled: true,
      sourceRoot: "/repo/t3code",
      buildSha: BUILD_SHA,
      runGit: runner,
    });

    expect(result).toMatchObject({ available: true, behind: false, error: null });
  });

  it("skips git entirely when rebuilds are unavailable", async () => {
    const runner = vi.fn();
    const result = await checkLocalDevRebuildStaleness({
      enabled: false,
      sourceRoot: null,
      buildSha: null,
      runGit: runner as unknown as GitRunner,
    });

    expect(result).toMatchObject({ available: false, behind: false });
    expect(runner).not.toHaveBeenCalled();
  });

  it("reports errors instead of behind when git or the network fails", async () => {
    const offline: GitRunner = async (args) => {
      if (args[0] === "ls-remote") throw new Error("Could not resolve host");
      return { stdout: `${LOCAL_SHA}\n`, exitCode: 0 };
    };
    const result = await checkLocalDevRebuildStaleness({
      enabled: true,
      sourceRoot: "/repo/t3code",
      buildSha: BUILD_SHA,
      runGit: offline,
    });

    expect(result.available).toBe(true);
    expect(result.behind).toBe(false);
    expect(result.error).toEqual(expect.any(String));
  });

  it("reports an error when the checkout is not a git repository", async () => {
    const { runner } = stubRunner({
      "rev-parse HEAD": { stdout: "", exitCode: 128 },
      "branch --show-current": { stdout: "", exitCode: 128 },
      "ls-remote --symref origin HEAD": {
        stdout: `ref: refs/heads/main\tHEAD\n${REMOTE_SHA}\tHEAD\n`,
        exitCode: 0,
      },
    });

    const result = await checkLocalDevRebuildStaleness({
      enabled: true,
      sourceRoot: "/repo/t3code",
      buildSha: BUILD_SHA,
      runGit: runner,
    });

    expect(result.behind).toBe(false);
    expect(result.error).toEqual(expect.any(String));
  });

  it("compares abbreviated build metadata and detects unfetched remote commits without moving local refs", async () => {
    const { root, sourceRoot, initialSha } = makeRealRemoteCheckout();
    try {
      for (const buildSha of [initialSha, initialSha.slice(0, 12)]) {
        const unchanged = await checkLocalDevRebuildStaleness({
          enabled: true,
          sourceRoot,
          buildSha,
        });
        expect(unchanged).toMatchObject({ behind: false, error: null });
      }

      const trackingRefBefore = git(sourceRoot, ["rev-parse", "refs/remotes/origin/main"]);
      const fetchHeadPath = Path.join(sourceRoot, ".git", "FETCH_HEAD");
      const fetchHeadBefore = FS.existsSync(fetchHeadPath)
        ? FS.readFileSync(fetchHeadPath, "utf8")
        : null;
      pushRemoteCommit(root);

      const updated = await checkLocalDevRebuildStaleness({
        enabled: true,
        sourceRoot,
        buildSha: initialSha,
      });

      expect(updated).toMatchObject({
        behind: true,
        behindBy: 1,
        readyToPull: true,
        readinessReason: null,
        error: null,
      });
      expect(git(sourceRoot, ["rev-parse", "HEAD"])).toBe(initialSha);
      expect(git(sourceRoot, ["rev-parse", "refs/remotes/origin/main"])).toBe(trackingRefBefore);
      expect(FS.existsSync(fetchHeadPath) ? FS.readFileSync(fetchHeadPath, "utf8") : null).toBe(
        fetchHeadBefore,
      );
      expect(git(sourceRoot, ["for-each-ref", "--format=%(refname)", "refs/t3code"])).toBe("");
    } finally {
      FS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps update availability separate from source checkout pull readiness", async () => {
    const { root, sourceRoot, initialSha } = makeRealRemoteCheckout();
    try {
      pushRemoteCommit(root);
      git(sourceRoot, ["switch", "-c", "feature"]);

      const result = await checkLocalDevRebuildStaleness({
        enabled: true,
        sourceRoot,
        buildSha: initialSha,
      });

      expect(result).toMatchObject({
        behind: true,
        readyToPull: false,
        readinessReason: expect.stringContaining("switch to 'main'"),
      });
      expect(git(sourceRoot, ["branch", "--show-current"])).toBe("feature");
      expect(git(sourceRoot, ["rev-parse", "HEAD"])).toBe(initialSha);
    } finally {
      FS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("deepens a shallow checkout to compare a missing build commit", async () => {
    const { root, initialSha } = makeRealRemoteCheckout();
    try {
      pushRemoteCommit(root);
      const shallowRoot = Path.join(root, "shallow-source");
      execFileSync("git", [
        "clone",
        "--depth=1",
        pathToFileURL(Path.join(root, "origin.git")).href,
        shallowRoot,
      ]);
      expect(git(shallowRoot, ["rev-parse", "--is-shallow-repository"])).toBe("true");

      const result = await checkLocalDevRebuildStaleness({
        enabled: true,
        sourceRoot: shallowRoot,
        buildSha: initialSha,
      });

      expect(result).toMatchObject({ behind: true, behindBy: 1, readyToPull: true, error: null });
      expect(git(shallowRoot, ["rev-parse", "--is-shallow-repository"])).toBe("false");
      expect(git(shallowRoot, ["branch", "--show-current"])).toBe("main");
    } finally {
      FS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("explains dirty, detached, and diverged source checkouts without changing them", async () => {
    const dirty = makeRealRemoteCheckout();
    try {
      pushRemoteCommit(dirty.root);
      FS.writeFileSync(Path.join(dirty.sourceRoot, "untracked.txt"), "local data\n");
      const result = await checkLocalDevRebuildStaleness({
        enabled: true,
        sourceRoot: dirty.sourceRoot,
        buildSha: dirty.initialSha,
      });
      expect(result).toMatchObject({
        behind: true,
        readyToPull: false,
        readinessReason: expect.stringContaining("local changes"),
      });
      expect(FS.readFileSync(Path.join(dirty.sourceRoot, "untracked.txt"), "utf8")).toBe(
        "local data\n",
      );
    } finally {
      FS.rmSync(dirty.root, { recursive: true, force: true });
    }

    const detached = makeRealRemoteCheckout();
    try {
      pushRemoteCommit(detached.root);
      git(detached.sourceRoot, ["checkout", "--detach", "HEAD"]);
      const result = await checkLocalDevRebuildStaleness({
        enabled: true,
        sourceRoot: detached.sourceRoot,
        buildSha: detached.initialSha,
      });
      expect(result).toMatchObject({
        behind: true,
        readyToPull: false,
        readinessReason: expect.stringContaining("detached"),
      });
      expect(git(detached.sourceRoot, ["branch", "--show-current"])).toBe("");
    } finally {
      FS.rmSync(detached.root, { recursive: true, force: true });
    }

    const diverged = makeRealRemoteCheckout();
    try {
      git(diverged.sourceRoot, ["config", "user.name", "Rebuild Test"]);
      git(diverged.sourceRoot, ["config", "user.email", "rebuild-test@example.invalid"]);
      FS.writeFileSync(Path.join(diverged.sourceRoot, "local.txt"), "local\n");
      git(diverged.sourceRoot, ["add", "local.txt"]);
      git(diverged.sourceRoot, ["commit", "-m", "local-only"]);
      pushRemoteCommit(diverged.root);

      const result = await checkLocalDevRebuildStaleness({
        enabled: true,
        sourceRoot: diverged.sourceRoot,
        buildSha: diverged.initialSha,
      });
      expect(result).toMatchObject({
        behind: true,
        readyToPull: false,
        readinessReason: expect.stringContaining("diverged"),
      });
      expect(git(diverged.sourceRoot, ["log", "-1", "--format=%s"])).toBe("local-only");
    } finally {
      FS.rmSync(diverged.root, { recursive: true, force: true });
    }
  });
});

function makeRealRemoteCheckout(): {
  root: string;
  sourceRoot: string;
  initialSha: string;
} {
  const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "t3code-rebuild-git-"));
  const remoteRoot = Path.join(root, "origin.git");
  const seedRoot = Path.join(root, "seed");
  const sourceRoot = Path.join(root, "source");
  FS.mkdirSync(seedRoot, { recursive: true });
  execFileSync("git", ["init", "--bare", "--initial-branch=main", remoteRoot]);
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: seedRoot });
  git(seedRoot, ["config", "user.name", "Rebuild Test"]);
  git(seedRoot, ["config", "user.email", "rebuild-test@example.invalid"]);
  FS.writeFileSync(Path.join(seedRoot, "README"), "initial\n");
  git(seedRoot, ["add", "README"]);
  git(seedRoot, ["commit", "-m", "initial"]);
  const initialSha = git(seedRoot, ["rev-parse", "HEAD"]);
  git(seedRoot, ["remote", "add", "origin", remoteRoot]);
  git(seedRoot, ["push", "-u", "origin", "main"]);
  execFileSync("git", ["clone", remoteRoot, sourceRoot]);
  return { root, sourceRoot, initialSha };
}

function pushRemoteCommit(root: string): void {
  const remoteRoot = Path.join(root, "origin.git");
  const writerRoot = Path.join(root, `writer-${Math.random().toString(16).slice(2)}`);
  execFileSync("git", ["clone", remoteRoot, writerRoot]);
  git(writerRoot, ["config", "user.name", "Rebuild Test"]);
  git(writerRoot, ["config", "user.email", "rebuild-test@example.invalid"]);
  FS.writeFileSync(Path.join(writerRoot, "remote.txt"), "remote update\n");
  git(writerRoot, ["add", "remote.txt"]);
  git(writerRoot, ["commit", "-m", "remote-update"]);
  git(writerRoot, ["push", "origin", "main"]);
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

describe("local Dev rebuild pull", () => {
  const onDefaultBranch = (): Record<string, { stdout: string; exitCode: number }> => ({
    "ls-remote --symref origin HEAD": {
      stdout: `ref: refs/heads/main\tHEAD\n${REMOTE_SHA}\tHEAD\n`,
      exitCode: 0,
    },
    "branch --show-current": { stdout: "main\n", exitCode: 0 },
  });

  function trackingRunner(
    scenarios: Record<string, { stdout: string; exitCode: number; stderr?: string }>,
  ): { runner: GitRunner; calls: Array<readonly string[]> } {
    const calls: Array<readonly string[]> = [];
    const runner: GitRunner = async (args) => {
      calls.push(args);
      const hit = scenarios[args.join(" ")];
      if (!hit) throw new Error(`unexpected git invocation: ${args.join(" ")}`);
      return { stdout: hit.stdout, stderr: hit.stderr ?? "", exitCode: hit.exitCode };
    };
    return { runner, calls };
  }

  const cleanTree = {
    "status --porcelain --untracked-files=all --ignore-submodules=none": {
      stdout: "",
      exitCode: 0,
    },
  };

  it("pulls the advertised remote default branch before rebuilding", async () => {
    const { runner, calls } = trackingRunner({
      ...onDefaultBranch(),
      ...cleanTree,
      "-c merge.autostash=false -c rebase.autoStash=false pull --ff-only origin main": {
        stdout: "Already up to date.\n",
        exitCode: 0,
      },
    });

    const result = await pullLatestCheckoutChanges("/repo/t3code", runner);

    expect(result).toEqual({ ok: true, message: null });
    expect(calls).toEqual([
      ["ls-remote", "--symref", "origin", "HEAD"],
      ["branch", "--show-current"],
      ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"],
      [
        "-c",
        "merge.autostash=false",
        "-c",
        "rebase.autoStash=false",
        "pull",
        "--ff-only",
        "origin",
        "main",
      ],
    ]);
  });

  it("pulls origin/main without requiring a configured upstream", async () => {
    const { runner, calls } = trackingRunner({
      ...onDefaultBranch(),
      ...cleanTree,
      "-c merge.autostash=false -c rebase.autoStash=false pull --ff-only origin main": {
        stdout: "Already up to date.\n",
        exitCode: 0,
      },
    });

    const result = await pullLatestCheckoutChanges("/repo/t3code", runner);

    expect(result).toEqual({ ok: true, message: null });
    // No upstream lookup (rev-parse @{u}, branch --show-current -v, config
    // branch.*.merge): the explicit origin/branch invocation works whether
    // or not the local branch tracks anything.
    expect(
      calls.some(
        (args) =>
          args.join(" ").includes("@{u}") || args[0] === "config" || args.includes("@{upstream}"),
      ),
    ).toBe(false);
  });

  it("refuses to pull a dirty worktree, including untracked files", async () => {
    const { runner, calls } = trackingRunner({
      ...onDefaultBranch(),
      "status --porcelain --untracked-files=all --ignore-submodules=none": {
        stdout: " M src/app.ts\n?? scratch-notes.txt\n",
        exitCode: 0,
      },
    });

    const result = await pullLatestCheckoutChanges("/repo/t3code", runner);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("local changes");
    expect(calls.some((args) => args[0] === "pull" || args.includes("pull"))).toBe(false);
  });

  it("refuses to pull when the checkout is not on the advertised branch", async () => {
    const { runner, calls } = trackingRunner({
      "ls-remote --symref origin HEAD": {
        stdout: `ref: refs/heads/main\tHEAD\n${REMOTE_SHA}\tHEAD\n`,
        exitCode: 0,
      },
      "branch --show-current": { stdout: "feature\n", exitCode: 0 },
    });

    const result = await pullLatestCheckoutChanges("/repo/t3code", runner);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("switch to 'main'");
    expect(calls.some((args) => args[0] === "pull")).toBe(false);
  });

  it("refuses to pull a detached checkout", async () => {
    const { runner, calls } = trackingRunner({
      "ls-remote --symref origin HEAD": {
        stdout: `ref: refs/heads/main\tHEAD\n${REMOTE_SHA}\tHEAD\n`,
        exitCode: 0,
      },
      "branch --show-current": { stdout: "", exitCode: 0 },
    });

    const result = await pullLatestCheckoutChanges("/repo/t3code", runner);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("detached");
    expect(calls.some((args) => args[0] === "pull")).toBe(false);
  });

  it("aborts when the remote default branch cannot be determined", async () => {
    const { runner, calls } = trackingRunner({
      "ls-remote --symref origin HEAD": { stdout: "", exitCode: 128 },
      "branch --show-current": { stdout: "main\n", exitCode: 0 },
    });

    const result = await pullLatestCheckoutChanges("/repo/t3code", runner);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("remote default branch");
    expect(calls.some((args) => args[0] === "pull")).toBe(false);
  });

  it("refuses to pull when fast-forward is impossible and reports git's reason", async () => {
    const { runner } = trackingRunner({
      ...onDefaultBranch(),
      ...cleanTree,
      "-c merge.autostash=false -c rebase.autoStash=false pull --ff-only origin main": {
        stdout: "",
        stderr: "error: Your local changes would be overwritten by merge.\n",
        exitCode: 1,
      },
    });

    const result = await pullLatestCheckoutChanges("/repo/t3code", runner);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Your local changes would be overwritten");
  });

  it("reports a missing git binary instead of throwing", async () => {
    const runner: GitRunner = async () => {
      throw new Error("spawn git ENOENT");
    };

    const result = await pullLatestCheckoutChanges("/repo/t3code", runner);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("spawn git ENOENT");
  });
});

describe("local Dev rebuild start", () => {
  const enabledState = { enabled: true, sourceRoot: "/repo/t3code", reason: null };
  const launched = { accepted: true, logPath: "/tmp/dev-rebuild.log", message: null };

  function makeDeps(overrides?: {
    readonly pull?: LocalRebuildStartDeps["pullLatest"];
    readonly launch?: LocalRebuildStartDeps["launch"];
  }) {
    let started = false;
    const pull =
      overrides?.pull ?? (async () => ({ ok: true as const, message: null as string | null }));
    const launch =
      overrides?.launch ??
      (async () => ({
        accepted: true as const,
        logPath: "/tmp/dev-rebuild.log",
        message: null as string | null,
      }));
    return {
      isStarted: () => started,
      deps: {
        isStarted: () => started,
        setStarted: (next: boolean) => {
          started = next;
        },
        getState: () => enabledState,
        pullLatest: pull,
        launch,
        alreadyStartedLogPath: "/tmp/dev-rebuild.log",
        options: undefined as { pullLatest?: unknown } | undefined,
      },
    };
  }

  it("serializes concurrent starts behind the guard, even during a slow pull", async () => {
    let releasePull!: () => void;
    const pullGate = new Promise<void>((resolve) => {
      releasePull = resolve;
    });
    const pull = vi.fn(async () => {
      await pullGate;
      return { ok: true as const, message: null as string | null };
    });
    const launch = vi.fn(async () => launched);
    const { isStarted, deps } = makeDeps({ pull, launch });

    const first = runLocalRebuildStart({ ...deps, options: { pullLatest: true } });
    // Let the first invoke reach the pull await before the second arrives.
    await Promise.resolve();
    await Promise.resolve();
    const second = runLocalRebuildStart({ ...deps, options: { pullLatest: true } });
    const secondResult = await second;
    releasePull();
    const firstResult = await first;

    expect(secondResult).toEqual({
      accepted: false,
      logPath: "/tmp/dev-rebuild.log",
      message: "A local rebuild is already in progress.",
    });
    expect(firstResult).toEqual(launched);
    expect(pull).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledOnce();
    expect(isStarted()).toBe(true);
  });

  it("clears the guard when the pull fails so a later start can proceed", async () => {
    const pull = vi.fn(async () => ({ ok: false as const, message: "boom" }));
    const launch = vi.fn(async () => launched);
    const { isStarted, deps } = makeDeps({ pull, launch });

    const failed = await runLocalRebuildStart({ ...deps, options: { pullLatest: true } });
    expect(failed).toEqual({ accepted: false, logPath: null, message: "boom" });
    expect(launch).not.toHaveBeenCalled();
    expect(isStarted()).toBe(false);

    const retried = await runLocalRebuildStart(deps);
    expect(retried).toEqual(launched);
    expect(launch).toHaveBeenCalledOnce();
  });

  it("rebuilds the current checkout when no pull is requested", async () => {
    const pull = vi.fn();
    const launch = vi.fn(async () => launched);
    const { deps } = makeDeps({ pull, launch });

    const result = await runLocalRebuildStart(deps);

    expect(result).toEqual(launched);
    expect(pull).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledOnce();
  });
});
