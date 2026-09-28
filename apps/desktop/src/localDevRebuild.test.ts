import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  checkLocalDevRebuildStaleness,
  decideRebuildStaleness,
  launchLocalDevRebuild,
  parseLsRemoteSymrefHead,
  pullLatestCheckoutChanges,
  readEmbeddedDevSourceRoot,
  resolveLocalDevRebuildState,
  type GitRunner,
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
      if (!hit) throw new Error(`unexpected git invocation: ${key}`);
      return hit;
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
});

describe("local Dev rebuild pull", () => {
  it("fast-forwards the checkout before rebuilding", async () => {
    const calls: Array<{ args: readonly string[]; cwd: string }> = [];
    const runner: GitRunner = async (args, cwd) => {
      calls.push({ args, cwd });
      return { stdout: "Already up to date.\n", exitCode: 0 };
    };

    const result = await pullLatestCheckoutChanges("/repo/t3code", runner);

    expect(result).toEqual({ ok: true, message: null });
    expect(calls).toEqual([{ args: ["pull", "--ff-only"], cwd: "/repo/t3code" }]);
  });

  it("refuses to pull when fast-forward is impossible and reports git's reason", async () => {
    const runner: GitRunner = async () => ({
      stdout: "",
      stderr: "error: Your local changes would be overwritten by merge.\n",
      exitCode: 1,
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
