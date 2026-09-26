// @effect-diagnostics nodeBuiltinImport:off globalDate:off - the module under test is plain Node; fixtures are built with real git.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import {
  gitAnswerMemoKey,
  makeTaskLimiter,
  parseGitConfig,
  rememberGitAnswer,
  resetGitFastPathCaches,
  tryAnswerGitCommand,
} from "./GitMetadataFastPath.ts";

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const UPSTREAM_FORMAT =
  "--format=%(refname)%00%(upstream:short)%00%(upstream:remotename)%00%(upstream:remoteref)";

const COMMANDS: ReadonlyArray<ReadonlyArray<string>> = [
  ["for-each-ref", "--format=%(refname)", "refs/remotes"],
  ["for-each-ref", "--format=%(refname)", "refs/heads/feature"],
  ["for-each-ref", "--format=%(refname)", "refs/heads/feat"],
  ["for-each-ref", "--format=%(refname)", "refs/remotes/origin/main", "refs/remotes/Upstream/main"],
  ["for-each-ref", "--count=1", "--format=%(refname)", "refs/remotes/*/main"],
  ["for-each-ref", "--count=1", "--format=%(refname)", "refs/remotes/*/missing"],
  ["for-each-ref", UPSTREAM_FORMAT, "refs/heads/main"],
  ["for-each-ref", UPSTREAM_FORMAT, "refs/heads/packed"],
  ["for-each-ref", UPSTREAM_FORMAT, "refs/heads/missing"],
  ["rev-parse", "--is-inside-work-tree"],
  ["rev-parse", "--show-toplevel"],
  ["rev-parse", "--git-common-dir"],
  ["rev-parse", "--abbrev-ref", "HEAD"],
  ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
  ["rev-list", "--count", "origin/main..HEAD"],
  ["rev-list", "--left-right", "--count", "HEAD...origin/main"],
  ["symbolic-ref", "--quiet", "--short", "HEAD"],
  ["symbolic-ref", "refs/remotes/origin/HEAD"],
  ["remote"],
  ["remote", "-v"],
  ["remote", "get-url", "origin"],
  ["remote", "get-url", "missing"],
  ["config", "--get", "branch.main.remote"],
  ["config", "--get", "Branch.main.Merge"],
  ["config", "--get", "branch.missing.remote"],
  ["config", "--get", "remote.origin.url"],
  ["show-ref", "--verify", "--quiet", "refs/heads/main"],
  ["show-ref", "--verify", "--quiet", "refs/heads/packed"],
  ["show-ref", "--verify", "--quiet", "refs/heads/feature/nested"],
  ["show-ref", "--verify", "--quiet", "refs/heads/missing"],
];

let root: string;
const repos: Record<string, string> = {};

function makeRepo(name: string, setup: (dir: string) => void = () => {}) {
  const dir = NodePath.join(root, name);
  NodeFS.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  NodeFS.writeFileSync(NodePath.join(dir, "file.txt"), "content\n");
  git(dir, "add", ".");
  git(
    dir,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "init",
  );
  setup(dir);
  repos[name] = dir;
  return dir;
}

// The suite pins git config through GIT_CONFIG_* variables, and those make the fast
// path decline everything. The fixtures here do not depend on the pinned values.
const pinnedGitConfig = Object.entries(process.env).filter(([key]) =>
  key.startsWith("GIT_CONFIG_"),
);

beforeAll(() => {
  for (const [key] of pinnedGitConfig) delete process.env[key];
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-git-fast-path-"));
  makeRepo("plain", (dir) => {
    git(dir, "remote", "add", "origin", "https://github.com/acme/widgets.git");
    git(dir, "remote", "add", "Upstream", "git@github.com:other/widgets.git");
    git(dir, "remote", "set-url", "--push", "Upstream", "https://example.com/push.git");
    git(dir, "config", "branch.main.remote", "origin");
    git(dir, "config", "branch.main.merge", "refs/heads/main");
    git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    git(dir, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    git(dir, "branch", "--set-upstream-to=origin/main", "main");
    git(dir, "branch", "packed");
    git(dir, "pack-refs", "--all");
    git(dir, "branch", "feature/nested");
    NodeFS.mkdirSync(NodePath.join(dir, "nested", "deeper"), { recursive: true });
  });
  repos.nested = NodePath.join(repos.plain!, "nested", "deeper");
  repos.linkedWorktree = NodePath.join(root, "linked");
  git(repos.plain!, "worktree", "add", "-q", repos.linkedWorktree, "feature/nested");
  makeRepo("detached", (dir) => git(dir, "checkout", "-q", "--detach"));
  makeRepo("noRemotes");
  makeRepo("worktreeConfig", (dir) => {
    git(dir, "remote", "add", "origin", "https://example.com/shared.git");
    git(dir, "config", "extensions.worktreeConfig", "true");
    git(dir, "config", "--worktree", "remote.origin.url", "https://example.com/per-worktree.git");
    git(dir, "config", "--worktree", "branch.main.remote", "origin");
  });
  repos.notARepository = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "t3-git-fast-path-none-"),
  );
});

afterAll(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
  NodeFS.rmSync(repos.notARepository!, { recursive: true, force: true });
  for (const [key, value] of pinnedGitConfig) process.env[key] = value;
});
afterEach(() => {
  delete process.env.GIT_DIR;
  delete process.env.T3CODE_GIT_FAST_PATH;
  resetGitFastPathCaches();
});

describe("GitMetadataFastPath", () => {
  it("prints exactly what git prints, or declines", async () => {
    let answered = 0;
    for (const [name, cwd] of Object.entries(repos)) {
      for (const args of COMMANDS) {
        const fast = await tryAnswerGitCommand({ cwd, args });
        if (fast === null) continue;
        answered++;
        const real = NodeChildProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
        expect({ name, args, exitCode: fast.exitCode, stdout: fast.stdout }).toEqual({
          name,
          args,
          exitCode: real.status,
          stdout: real.stdout,
        });
      }
    }
    // Guards against the fast path silently declining everything.
    expect(answered).toBeGreaterThan(60);
  });

  it("accepts the -C and --git-dir forms the drivers use", async () => {
    const cwd = repos.plain!;
    expect(await tryAnswerGitCommand({ cwd: root, args: ["-C", cwd, "remote"] })).toEqual({
      exitCode: 0,
      stdout: "Upstream\norigin\n",
      stderr: "",
    });
    const gitDir = NodePath.join(cwd, ".git");
    expect(
      await tryAnswerGitCommand({
        cwd,
        args: ["--git-dir", gitDir, "remote", "get-url", "origin"],
      }),
    ).toMatchObject({ stdout: "https://github.com/acme/widgets.git\n" });
  });

  it.each([
    ["commands it does not know", (dir: string) => dir, ["status", "--porcelain"]],
    ["extra arguments", (dir: string) => dir, ["remote", "-v", "show"]],
    [
      "ref listings that need object data",
      (dir: string) => dir,
      ["for-each-ref", "--format=%(refname)%09%(committerdate:unix)", "refs/heads"],
    ],
    [
      "ref listings outside branches",
      (dir: string) => dir,
      ["for-each-ref", "--format=%(refname)", "refs/tags"],
    ],
    [
      "ref names that escape the git directory",
      (dir: string) => dir,
      ["show-ref", "--verify", "--quiet", "refs/heads/../../config"],
    ],
    ["a missing remote, so git reports it", (dir: string) => dir, ["remote", "get-url", "missing"]],
    [
      "the inside of a git directory",
      (dir: string) => NodePath.join(dir, ".git"),
      ["rev-parse", "--show-toplevel"],
    ],
  ] as const)("declines %s", async (_label, cwdOf, args) => {
    expect(await tryAnswerGitCommand({ cwd: cwdOf(repos.plain!), args })).toBeNull();
  });

  it("declines repositories whose config it cannot fully account for", async () => {
    const rewritten = makeRepo("rewritten", (dir) => {
      git(dir, "remote", "add", "origin", "gh:acme/widgets.git");
      git(dir, "config", "url.https://github.com/.insteadOf", "gh:");
    });
    expect(await tryAnswerGitCommand({ cwd: rewritten, args: ["remote", "-v"] })).toBeNull();

    const included = makeRepo("included", (dir) =>
      git(dir, "config", "include.path", "../extra.cfg"),
    );
    expect(
      await tryAnswerGitCommand({ cwd: included, args: ["rev-parse", "--show-toplevel"] }),
    ).toBeNull();

    const ambiguous = makeRepo("ambiguous", (dir) => git(dir, "tag", "main"));
    expect(
      await tryAnswerGitCommand({ cwd: ambiguous, args: ["rev-parse", "--abbrev-ref", "HEAD"] }),
    ).toBeNull();

    const localUpstream = makeRepo("localUpstream", (dir) => {
      git(dir, "branch", "topic");
      git(dir, "branch", "--set-upstream-to=main", "topic");
    });
    expect(
      await tryAnswerGitCommand({
        cwd: localUpstream,
        args: ["for-each-ref", UPSTREAM_FORMAT, "refs/heads/topic"],
      }),
    ).toBeNull();

    const unborn = NodePath.join(root, "unborn");
    NodeFS.mkdirSync(unborn);
    git(unborn, "init", "-q", "-b", "trunk");
    expect(
      await tryAnswerGitCommand({ cwd: unborn, args: ["rev-parse", "--abbrev-ref", "HEAD"] }),
    ).toBeNull();
  });

  it("declines when the environment redirects git or the switch is off", async () => {
    const input = { cwd: repos.plain!, args: ["remote"] };
    expect(
      await tryAnswerGitCommand({ ...input, env: { GIT_CONFIG_GLOBAL: "/dev/null" } }),
    ).toBeNull();
    process.env.GIT_DIR = "elsewhere";
    expect(await tryAnswerGitCommand(input)).toBeNull();
    delete process.env.GIT_DIR;
    process.env.T3CODE_GIT_FAST_PATH = "0";
    expect(await tryAnswerGitCommand(input)).toBeNull();
    delete process.env.T3CODE_GIT_FAST_PATH;
    expect(await tryAnswerGitCommand(input)).not.toBeNull();
  });

  it("reports a missing upstream the way git does", async () => {
    const args = ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"];
    const cwd = repos.noRemotes!;
    const real = NodeChildProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
    expect(await tryAnswerGitCommand({ cwd, args })).toEqual({
      exitCode: real.status,
      stdout: real.stdout,
      stderr: real.stderr,
    });
  });

  it("counts commits only for a pair of commits git already counted", async () => {
    const commit = (cwd: string, message: string) =>
      git(
        cwd,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        message,
      );
    const cwd = makeRepo("diverged", (dir) => {
      git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
      commit(dir, "local");
    });
    const input = { cwd, args: ["rev-list", "--left-right", "--count", "HEAD...origin/main"] };
    const ask = () =>
      NodeChildProcess.spawnSync("git", input.args, { cwd, encoding: "utf8" }).stdout;

    expect(await tryAnswerGitCommand(input)).toBeNull();
    const key = await gitAnswerMemoKey(input);
    expect(key).not.toBeNull();
    await rememberGitAnswer(input, key!, ask());
    expect(await tryAnswerGitCommand(input)).toMatchObject({ exitCode: 0, stdout: "1\t0\n" });

    // A moved ref is a different question.
    commit(cwd, "local 2");
    expect(await tryAnswerGitCommand(input)).toBeNull();

    // An answer that raced with a ref update is not stored.
    const staleKey = await gitAnswerMemoKey(input);
    const staleAnswer = ask();
    commit(cwd, "local 3");
    await rememberGitAnswer(input, staleKey!, staleAnswer);
    expect(await tryAnswerGitCommand(input)).toBeNull();

    // Shallow history changes counts without changing the commits.
    NodeFS.writeFileSync(NodePath.join(cwd, ".git", "shallow"), "");
    expect(await gitAnswerMemoKey(input)).toBeNull();
  });

  it("sees changes immediately, without a cache to go stale", async () => {
    const cwd = makeRepo("changing");
    expect(await tryAnswerGitCommand({ cwd, args: ["remote"] })).toMatchObject({ stdout: "" });
    git(cwd, "remote", "add", "origin", "https://example.com/one.git");
    git(cwd, "checkout", "-q", "-b", "next");
    git(cwd, "pack-refs", "--all");
    expect(await tryAnswerGitCommand({ cwd, args: ["remote", "get-url", "origin"] })).toMatchObject(
      {
        stdout: "https://example.com/one.git\n",
      },
    );
    expect(
      await tryAnswerGitCommand({ cwd, args: ["rev-parse", "--abbrev-ref", "HEAD"] }),
    ).toMatchObject({
      stdout: "next\n",
    });
  });
});

describe("GitMetadataFastPath on repositories git treats differently", () => {
  const savedEnv = new Map<string, string | undefined>();
  const setEnv = (key: string, value: string) => {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    process.env[key] = value;
    resetGitFastPathCaches();
  };
  afterEach(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnv.clear();
  });

  /** A home directory whose `.gitconfig` is the global config for git and the fast path alike. */
  const useGlobalConfig = (name: string, body: string) => {
    const home = NodePath.join(root, name);
    NodeFS.mkdirSync(home, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(home, ".gitconfig"), body);
    setEnv("HOME", home);
    setEnv("USERPROFILE", home);
    setEnv("XDG_CONFIG_HOME", NodePath.join(home, "xdg"));
    return home;
  };

  const declines = async (cwd: string, ...args: ReadonlyArray<string>) =>
    expect({ args, answer: await tryAnswerGitCommand({ cwd, args }) }).toEqual({
      args,
      answer: null,
    });

  /** For cases where answering is fine as long as the answer is git's. */
  const agreesWithGit = async (cwd: string, ...args: ReadonlyArray<string>) => {
    const fast = await tryAnswerGitCommand({ cwd, args });
    if (fast === null) return;
    const real = NodeChildProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
    expect({ args, ...fast }).toEqual({
      args,
      exitCode: real.status,
      stdout: real.stdout,
      stderr: real.stderr,
    });
  };

  const headOf = (cwd: string) => git(cwd, "rev-parse", "HEAD").trim();

  it("says what git says outside a repository, stderr included", async () => {
    const cwd = repos.notARepository!;
    const args = ["rev-parse", "--show-toplevel"];
    const real = NodeChildProcess.spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    });
    expect(await tryAnswerGitCommand({ cwd, args, env: { LC_ALL: "C" } })).toEqual({
      exitCode: real.status,
      stdout: real.stdout,
      stderr: real.stderr,
    });
    // These work without a repository, from system and global config or from nothing at all.
    await declines(cwd, "config", "--get", "remote.origin.url");
    await declines(cwd, "config", "--get", "branch.main.remote");
    await declines(cwd, "rev-parse", "--sq-quote", "x");
    await declines(cwd, "rev-parse", "--git-dir");
  });

  it("keeps English error text away from a git that would translate it", async () => {
    const upstream = ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"];
    const translated = { LC_ALL: "de_DE.UTF-8" };
    expect(
      await tryAnswerGitCommand({ cwd: repos.noRemotes!, args: upstream, env: translated }),
    ).toBeNull();
    expect(
      await tryAnswerGitCommand({
        cwd: repos.notARepository!,
        args: ["rev-parse", "--show-toplevel"],
        env: translated,
      }),
    ).toBeNull();
    setEnv("LANG", "de_DE.UTF-8");
    setEnv("LC_ALL", "");
    expect(await tryAnswerGitCommand({ cwd: repos.noRemotes!, args: upstream })).toBeNull();
  });

  it("leaves remotes that git lists differently to git", async () => {
    const urlLess = makeRepo("urlLess", (dir) => {
      git(dir, "remote", "add", "origin", "https://example.com/origin.git");
      git(dir, "config", "remote.old.fetch", "+refs/heads/*:refs/remotes/old/*");
    });
    await declines(urlLess, "remote");
    await declines(urlLess, "remote", "-v");

    useGlobalConfig("home-global-remote", '[remote "shared"]\n\turl = https://example.com/s.git\n');
    // `get-url` wants the remote in the repository and exits 2 otherwise.
    await declines(repos.noRemotes!, "remote", "get-url", "shared");
    await agreesWithGit(repos.noRemotes!, "remote");
    await agreesWithGit(repos.noRemotes!, "remote", "-v");
    await agreesWithGit(repos.noRemotes!, "config", "--get", "remote.shared.url");
  });

  it("notices a changed global config under an unusual path", async () => {
    const home = useGlobalConfig("ho#me dir", '[remote "shared"]\n\turl = https://one\n');
    const args = ["config", "--get", "remote.shared.url"];
    await agreesWithGit(repos.noRemotes!, ...args);
    NodeFS.writeFileSync(
      NodePath.join(home, ".gitconfig"),
      '[remote "shared"]\n\turl = https://another.example\n',
    );
    await agreesWithGit(repos.noRemotes!, ...args);
  });

  it("declines when git cannot be run", async () => {
    setEnv("PATH", NodePath.join(root, "no-git-here"));
    await declines(repos.plain!, "rev-parse", "--show-toplevel");
    await declines(repos.notARepository!, "rev-parse", "--show-toplevel");
  });

  it("honours the switch in the command's own environment", async () => {
    expect(
      await tryAnswerGitCommand({
        cwd: repos.plain!,
        args: ["remote"],
        env: { T3CODE_GIT_FAST_PATH: "0" },
      }),
    ).toBeNull();
  });

  it("leaves the command to git when its environment moves git or its config", async () => {
    const home = useGlobalConfig(
      "home-ambient",
      '[remote "shared"]\n\turl = https://ambient.example\n',
    );
    const otherHome = NodePath.join(root, "home-of-the-command");
    NodeFS.mkdirSync(otherHome, { recursive: true });
    const args = ["config", "--get", "remote.shared.url"];
    const cwd = repos.noRemotes!;
    // The spawned git would read the other home's config, which has no such remote.
    for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME"]) {
      expect(await tryAnswerGitCommand({ cwd, args, env: { [key]: otherHome } })).toBeNull();
    }
    expect(
      await tryAnswerGitCommand({ cwd, args, env: { PATH: NodePath.join(root, "other-git") } }),
    ).toBeNull();
    // Restating the server's own value changes nothing.
    expect(await tryAnswerGitCommand({ cwd, args, env: { HOME: home } })).toEqual({
      exitCode: 0,
      stdout: "https://ambient.example\n",
      stderr: "",
    });
  });

  it("notices a global include that appears after the config was listed", async () => {
    const home = useGlobalConfig(
      "home-include",
      "[include]\n\tpath = later.inc\n\tpath = ~/tilde.inc\n",
    );
    const cwd = repos.noRemotes!;
    const get = (name: string) => ["config", "--get", `remote.${name}.url`];
    expect(await tryAnswerGitCommand({ cwd, args: get("later") })).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "",
    });
    const answered = async (file: string, name: string) => {
      NodeFS.writeFileSync(
        NodePath.join(home, file),
        `[remote "${name}"]\n\turl = https://${name}.example\n`,
      );
      expect(await tryAnswerGitCommand({ cwd, args: get(name) })).toEqual({
        exitCode: 0,
        stdout: `https://${name}.example\n`,
        stderr: "",
      });
    };
    await answered("later.inc", "later");
    await answered("tilde.inc", "tilde");
  });

  it("stays inside the caller's time and output budget", async () => {
    const cwd = repos.plain!;
    expect(await tryAnswerGitCommand({ cwd, args: ["remote", "-v"], timeoutMs: 0 })).toBeNull();
    // Same with everything already cached, when the reads alone might beat a zero timer.
    expect(await tryAnswerGitCommand({ cwd, args: ["remote", "-v"] })).not.toBeNull();
    expect(await tryAnswerGitCommand({ cwd, args: ["remote", "-v"], timeoutMs: 0 })).toBeNull();
    expect(
      await tryAnswerGitCommand({ cwd, args: ["remote", "-v"], timeoutMs: null }),
    ).not.toBeNull();

    const listing = git(cwd, "remote", "-v");
    const fits = Buffer.byteLength(listing);
    expect(
      await tryAnswerGitCommand({ cwd, args: ["remote", "-v"], maxOutputBytes: fits }),
    ).toEqual({ exitCode: 0, stdout: listing, stderr: "" });
    expect(
      await tryAnswerGitCommand({ cwd, args: ["remote", "-v"], maxOutputBytes: fits - 1 }),
    ).toBeNull();
    // stderr counts too: the missing-upstream message is longer than this cap.
    expect(
      await tryAnswerGitCommand({
        cwd: repos.noRemotes!,
        args: ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
        env: { LC_ALL: "C" },
        maxOutputBytes: 8,
      }),
    ).toBeNull();
  });

  it.skipIf(NodePath.sep === "\\")(
    "does not wait on a FIFO standing where a file would be",
    async () => {
      const fifoRepo = makeRepo("fifo");
      NodeChildProcess.execFileSync("mkfifo", [NodePath.join(fifoRepo, ".git", "packed-refs")]);
      await declines(fifoRepo, "show-ref", "--verify", "--quiet", "refs/heads/missing");
    },
  );

  it("remembers that the global config could not be used instead of asking git every time", async () => {
    // A key without a value is legal to git; this reader leaves such a config to git.
    const home = useGlobalConfig("home-valueless", "[core]\n\tvalueless\n");
    const args = ["remote", "get-url", "origin"];
    await declines(repos.plain!, ...args);

    NodeFS.writeFileSync(NodePath.join(home, ".gitconfig"), "");
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now });
    try {
      // Still inside the retry pause: the listing is not repeated for this command.
      await declines(repos.plain!, ...args);
      vi.setSystemTime(now + 31_000);
      expect(await tryAnswerGitCommand({ cwd: repos.plain!, args })).toEqual({
        exitCode: 0,
        stdout: "https://github.com/acme/widgets.git\n",
        stderr: "",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves refs that belong to one worktree to git", async () => {
    const linked = repos.linkedWorktree!;
    git(linked, "update-ref", "refs/bisect/bad", "HEAD");
    git(linked, "update-ref", "refs/worktree/mark", "HEAD");
    for (const cwd of [linked, repos.plain!]) {
      await declines(cwd, "show-ref", "--verify", "--quiet", "refs/bisect/bad");
      await declines(cwd, "show-ref", "--verify", "--quiet", "refs/worktree/mark");
      await declines(cwd, "show-ref", "--verify", "--quiet", "refs/rewritten/onto");
    }
  });

  it("walks past a directory with a broken HEAD, as git does", async () => {
    const outer = makeRepo("outerOfBroken", (dir) =>
      git(dir, "remote", "add", "origin", "https://example.com/outer.git"),
    );
    for (const [name, head] of [
      ["empty", ""],
      ["garbage", "garbage\n"],
      ["huge", `ref: refs/heads/main${" ".repeat(8 * 1024)}\n`],
    ] as const) {
      const inner = NodePath.join(outer, name);
      NodeFS.mkdirSync(inner);
      git(inner, "init", "-q");
      NodeFS.writeFileSync(NodePath.join(inner, ".git", "HEAD"), head);
      await agreesWithGit(inner, "rev-parse", "--show-toplevel");
      if (name === "empty") {
        expect(
          await tryAnswerGitCommand({ cwd: inner, args: ["rev-parse", "--show-toplevel"] }),
        ).toMatchObject({ stdout: git(outer, "rev-parse", "--show-toplevel") });
      }
      await agreesWithGit(inner, "remote", "get-url", "origin");
      await declines(outer, "--git-dir", NodePath.join(inner, ".git"), "remote");
    }
  });

  it("never follows a repository pointer to another machine", async () => {
    const pointer = NodePath.join(root, "uncPointer");
    NodeFS.mkdirSync(pointer);
    // TEST-NET address: nothing may try to reach it.
    NodeFS.writeFileSync(NodePath.join(pointer, ".git"), "gitdir: //203.0.113.1/share/repo.git\n");
    await declines(pointer, "remote");
    await declines(root, "--git-dir", "//203.0.113.1/share/repo.git", "remote");
    await declines(root, "--git-dir", "\\\\203.0.113.1\\share\\repo.git", "remote");

    const main = makeRepo("uncCommonDirMain");
    const linked = NodePath.join(root, "uncCommonDirLinked");
    git(main, "worktree", "add", "-q", "-b", "side", linked);
    const linkedGitDir = NodePath.join(main, ".git", "worktrees", "uncCommonDirLinked");
    NodeFS.writeFileSync(
      NodePath.join(linkedGitDir, "commondir"),
      "//203.0.113.1/share/repo.git\n",
    );
    await declines(linked, "remote");
  });

  it("reads config the way git does, or not at all", async () => {
    const bare = makeRepo("numericBare", (dir) => git(dir, "config", "core.bare", "2"));
    await declines(bare, "rev-parse", "--is-inside-work-tree");

    const versionless = makeRepo("versionless", (dir) => {
      git(dir, "remote", "add", "origin", "https://example.com/shared.git");
      git(dir, "config", "extensions.worktreeConfig", "true");
      git(dir, "config", "--worktree", "remote.origin.url", "https://example.com/ignored.git");
      git(dir, "config", "--unset", "core.repositoryformatversion");
    });
    await agreesWithGit(versionless, "remote", "get-url", "origin");

    const huge = makeRepo("hugeConfig", (dir) =>
      NodeFS.appendFileSync(NodePath.join(dir, ".git", "config"), `# ${"x".repeat(2_000_000)}\n`),
    );
    await declines(huge, "remote");

    const binary = makeRepo("binaryConfig", (dir) =>
      NodeFS.appendFileSync(
        NodePath.join(dir, ".git", "config"),
        Buffer.concat([
          Buffer.from('[remote "origin"]\n\turl = https://example.com/'),
          Buffer.from([0xff, 0xfe]),
          Buffer.from("\n"),
        ]),
      ),
    );
    await agreesWithGit(binary, "remote", "get-url", "origin");
    await agreesWithGit(binary, "remote", "-v");

    const loneCarriageReturn = makeRepo("loneCr", (dir) =>
      NodeFS.appendFileSync(
        NodePath.join(dir, ".git", "config"),
        '[remote "origin"]\n\turl = https://example.com/a\rb\n',
      ),
    );
    await agreesWithGit(loneCarriageReturn, "remote", "get-url", "origin");
  });

  it("refuses packed refs that git would die on", async () => {
    for (const [name, line] of [
      ["escaping", "refs/heads/../../evil"],
      ["nul", "refs/heads/ev\0il"],
      ["device", "refs/heads/NUL"],
    ] as const) {
      const cwd = makeRepo(`packed-${name}`, (dir) => {
        git(dir, "pack-refs", "--all");
        NodeFS.appendFileSync(
          NodePath.join(dir, ".git", "packed-refs"),
          `${headOf(dir)} ${line}\n`,
        );
      });
      await declines(cwd, "for-each-ref", "--format=%(refname)", "refs/heads");
      await declines(cwd, "show-ref", "--verify", "--quiet", "refs/heads/main");
    }

    const oversized = makeRepo("packed-oversized", (dir) => {
      const line = `${headOf(dir)} refs/heads/filler-${"x".repeat(200)}\n`;
      NodeFS.writeFileSync(
        NodePath.join(dir, ".git", "packed-refs"),
        `# pack-refs with: peeled fully-peeled sorted \n${line.repeat(140_000)}`,
      );
    });
    // `main` is a loose ref here, which neither git nor the fast path looks up in packed-refs.
    await declines(oversized, "show-ref", "--verify", "--quiet", "refs/heads/missing");
  });

  it("does not open ref names that Windows maps onto something else", async () => {
    for (const name of ["CON", "nul", "COM1", "aux.txt", "trailing.", "a/prn/b"]) {
      await declines(repos.plain!, "show-ref", "--verify", "--quiet", `refs/heads/${name}`);
    }
  });

  it("reports a ref whose name is only a directory as missing", async () => {
    const args = ["show-ref", "--verify", "--quiet", "refs/heads/feature"];
    const real = NodeChildProcess.spawnSync("git", args, { cwd: repos.plain!, encoding: "utf8" });
    expect(await tryAnswerGitCommand({ cwd: repos.plain!, args })).toMatchObject({
      exitCode: real.status,
      stdout: real.stdout,
    });
  });

  it("leaves symbolic ref chains and remote HEAD upstreams to git", async () => {
    const chained = makeRepo("symrefChain", (dir) => {
      git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
      git(dir, "symbolic-ref", "refs/remotes/origin/alias", "refs/remotes/origin/main");
      git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/alias");
    });
    await declines(chained, "symbolic-ref", "refs/remotes/origin/HEAD");

    const headUpstream = makeRepo("headUpstream", (dir) => {
      git(dir, "remote", "add", "origin", "https://example.com/origin.git");
      git(dir, "update-ref", "refs/remotes/origin/HEAD", "HEAD");
      git(dir, "config", "branch.main.remote", "origin");
      git(dir, "config", "branch.main.merge", "refs/heads/HEAD");
    });
    await declines(
      headUpstream,
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    );
    await declines(headUpstream, "for-each-ref", UPSTREAM_FORMAT, "refs/heads/main");
  });

  it("checks both git directories of a linked worktree for a rival short name", async () => {
    const main = makeRepo("rivalMain");
    const linked = NodePath.join(root, "rivalLinked");
    git(main, "worktree", "add", "-q", "-b", "topic", linked);
    NodeFS.writeFileSync(NodePath.join(main, ".git", "topic"), `${headOf(main)}\n`);
    await agreesWithGit(linked, "rev-parse", "--abbrev-ref", "HEAD");
    await agreesWithGit(linked, "symbolic-ref", "--quiet", "--short", "HEAD");
    NodeFS.writeFileSync(
      NodePath.join(main, ".git", "worktrees", "rivalLinked", "topic"),
      `${headOf(main)}\n`,
    );
    await agreesWithGit(linked, "rev-parse", "--abbrev-ref", "HEAD");
  });
});

describe("makeTaskLimiter", () => {
  it("runs a bounded number of tasks at once and frees the slot of a failed one", async () => {
    const limit = makeTaskLimiter(3);
    const release: Array<(fail: boolean) => void> = [];
    let running = 0;
    let mostRunning = 0;
    const results = Array.from({ length: 10 }, (_, index) =>
      limit(async () => {
        mostRunning = Math.max(mostRunning, ++running);
        const failed = await new Promise<boolean>((resolve) => release.push(resolve));
        running--;
        if (failed) throw new Error(`task ${index}`);
        return index;
      }).catch((error: Error) => error.message),
    );
    // Release in start order; every third task fails.
    for (let done = 0; done < 10; done++) {
      while (release.length <= done) await new Promise((resolve) => setImmediate(resolve));
      expect(running).toBeLessThanOrEqual(3);
      release[done]!(done % 3 === 0);
    }
    expect(await Promise.all(results)).toEqual([
      "task 0",
      1,
      2,
      "task 3",
      4,
      5,
      "task 6",
      7,
      8,
      "task 9",
    ]);
    expect(mostRunning).toBe(3);
  });
});

describe("parseGitConfig", () => {
  it("handles quoting, escapes, comments and continuations like git", () => {
    const entries = parseGitConfig(
      [
        "; comment",
        '[Remote "Origin"] # trailing',
        '\turl = "https://example.com/a b.git"  ; note',
        "\tfetch = +refs/heads/*:\\",
        "refs/remotes/origin/*",
        '[branch "we\\"ird"]',
        "\tReMoTe = a\\\\b\\tc",
        "[core]",
        "\tbare=false",
      ].join("\r\n"),
    );
    expect(entries).toEqual([
      { key: "remote.Origin.url", value: "https://example.com/a b.git" },
      { key: "remote.Origin.fetch", value: "+refs/heads/*:refs/remotes/origin/*" },
      { key: 'branch.we"ird.remote', value: "a\\b\tc" },
      { key: "core.bare", value: "false" },
    ]);
  });

  it.each([
    ["value-less keys", "[core]\n\tbare\n"],
    ["keys before a section", "name = value\n"],
    ["unterminated quotes", '[a]\n\tb = "open\n'],
    ["unknown escapes", "[a]\n\tb = \\q\n"],
    ["malformed headers", "[a b]\n"],
  ])("refuses %s instead of guessing", (_label, text) => {
    expect(() => parseGitConfig(text)).toThrow();
  });
});
