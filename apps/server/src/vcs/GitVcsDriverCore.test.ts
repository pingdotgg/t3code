import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, describe } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import { GitCommandError } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { ServerConfig } from "../config.ts";
import { splitNullSeparatedGitStdoutPaths } from "./GitVcsDriverCore.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-git-vcs-driver-test-",
});
const TestLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTmpDir = (
  prefix = "git-vcs-driver-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });

const writeTextFile = (
  cwd: string,
  relativePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const filePath = pathService.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(pathService.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFileString(filePath, contents);
  });

const git = (
  cwd: string,
  args: ReadonlyArray<string>,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<string, GitCommandError, GitVcsDriver.GitVcsDriver> =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "GitVcsDriver.test.git",
      cwd,
      args,
      ...(env ? { env } : {}),
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const findGitExecutable = Effect.fn("GitVcsDriver.test.findGitExecutable")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const pathDelimiter = (yield* HostProcessPlatform) === "win32" ? ";" : ":";
  for (const entry of (process.env.PATH ?? "").split(pathDelimiter)) {
    if (entry.length === 0) continue;
    const candidate = pathService.join(entry, "git");
    if (yield* fileSystem.exists(candidate)) {
      return yield* fileSystem.realPath(candidate);
    }
  }
  return yield* Effect.die(new Error("Could not find the Git executable in PATH."));
});

const initRepoWithCommit = (
  cwd: string,
): Effect.Effect<
  { readonly initialBranch: string },
  GitCommandError | PlatformError.PlatformError,
  GitVcsDriver.GitVcsDriver | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.initRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(cwd, "README.md", "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
    const initialBranch = yield* git(cwd, ["branch", "--show-current"]);
    return { initialBranch };
  });

it.layer(TestLayer)("GitVcsDriver core integration", (it) => {
  describe("structured errors", () => {
    it.effect("preserves structured spawn context and the platform cause", () =>
      Effect.gen(function* () {
        const parent = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const cwd = pathService.join(parent, "missing");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.missingCwd",
            cwd,
            args: ["status", "--short"],
          })
          .pipe(Effect.flip);

        assert.deepInclude(error, {
          _tag: "GitCommandError",
          operation: "GitVcsDriver.test.missingCwd",
          command: "git",
          argumentCount: 2,
          cwd,
          detail: "Failed to spawn Git process.",
        });
        if (!(error.cause instanceof PlatformError.PlatformError)) {
          return assert.fail("expected the original platform error cause");
        }
        assert.equal(error.cause.reason._tag, "NotFound");
        assert.notInclude(error.detail, error.cause.message);
      }),
    );

    it.effect("does not retain git arguments or stderr in command failures", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.initRepo({ cwd });

        const secret = "secret-token-value";
        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.redactedFailure",
            cwd,
            args: ["status", `--unknown-option=${secret}`],
          })
          .pipe(Effect.flip);

        assert.deepInclude(error, {
          _tag: "GitCommandError",
          operation: "GitVcsDriver.test.redactedFailure",
          command: "git",
          argumentCount: 2,
          cwd,
        });
        assert.isNumber(error.exitCode);
        assert.isAbove(error.stderrLength ?? 0, 0);
        assert.notInclude(error.detail, secret);
        assert.notInclude(error.message, secret);
        assert.notProperty(error, "args");
        assert.notProperty(error, "stderr");
      }),
    );

    it.effect("recovers a structurally identified missing cwd as a non-repository", () =>
      Effect.gen(function* () {
        const parent = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const cwd = pathService.join(parent, "missing");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* driver.refreshStatusUpstream(cwd);
        const [localStatus, remoteStatus, refs] = yield* Effect.all([
          driver.statusDetails(cwd),
          driver.statusDetailsRemote(cwd, { refreshUpstream: false }),
          driver.listRefs({ cwd }),
        ]);

        assert.equal(localStatus.isRepo, false);
        assert.equal(remoteStatus.isRepo, false);
        assert.equal(refs.isRepo, false);
        assert.deepStrictEqual(refs.refs, []);
      }),
    );

    it.effect("does not wrap a remove-worktree command failure in a synthetic error", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const missingWorktree = pathService.join(cwd, "missing-worktree");
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.initRepo({ cwd });

        const error = yield* driver
          .removeWorktree({ cwd, path: missingWorktree })
          .pipe(Effect.flip);

        assert.deepInclude(error, {
          _tag: "GitCommandError",
          operation: "GitVcsDriver.removeWorktree",
          command: "git",
          argumentCount: 3,
          cwd,
        });
        assert.notProperty(error, "cause");
        assert.notInclude(error.detail, "Git command failed in");
      }),
    );
  });

  describe("review diff previews", () => {
    it.effect("drops an unterminated path from truncated NUL-separated git output", () =>
      Effect.sync(() => {
        const paths = splitNullSeparatedGitStdoutPaths({
          stdout: "complete.txt\0partial",
          stdoutTruncated: true,
        });

        assert.deepStrictEqual(paths, ["complete.txt"]);
      }),
    );

    it.effect("keeps the final path when NUL-separated git output is complete", () =>
      Effect.sync(() => {
        const paths = splitNullSeparatedGitStdoutPaths({
          stdout: "complete.txt\0final.txt",
          stdoutTruncated: false,
        });

        assert.deepStrictEqual(paths, ["complete.txt", "final.txt"]);
      }),
    );

    it.effect("honors whitespace filtering for worktree and branch previews", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["checkout", "-b", "feature/whitespace"]);
        yield* writeTextFile(cwd, "README.md", "#  test\n");
        yield* git(cwd, ["add", "README.md"]);
        yield* git(cwd, ["commit", "-m", "change whitespace"]);
        yield* writeTextFile(cwd, "README.md", "#   test\n");

        const included = yield* driver.getReviewDiffPreview({
          cwd,
          baseRef: initialBranch,
          ignoreWhitespace: false,
        });
        const ignored = yield* driver.getReviewDiffPreview({
          cwd,
          baseRef: initialBranch,
          ignoreWhitespace: true,
        });

        assert.isNotEmpty(included.sources.find((source) => source.kind === "working-tree")?.diff);
        assert.isNotEmpty(included.sources.find((source) => source.kind === "branch-range")?.diff);
        assert.strictEqual(
          ignored.sources.find((source) => source.kind === "working-tree")?.diff,
          "",
        );
        assert.strictEqual(
          ignored.sources.find((source) => source.kind === "branch-range")?.diff,
          "",
        );
      }),
    );
  });

  describe("repository status", () => {
    it.effect("reports non-repository directories without failing", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const refs = yield* driver.listRefs({ cwd });
        assert.equal(refs.isRepo, false);
        assert.deepStrictEqual(refs.refs, []);
      }),
    );

    it.effect("reports refName and dirty state for a repository", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "feature.ts", "export const value = 1;\n");

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.isRepo, true);
        assert.equal(status.branch, initialBranch);
        assert.equal(status.hasWorkingTreeChanges, true);
        assert.include(
          status.workingTree.files.map((file) => file.path),
          "feature.ts",
        );
      }),
    );

    it.effect("reports default-branch delta separately from upstream delta", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["checkout", "-b", "feature/synced"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "feature.txt"]);
        yield* git(cwd, ["commit", "-m", "feature commit"]);
        yield* git(cwd, ["push", "-u", "origin", "feature/synced"]);

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.hasUpstream, true);
        assert.equal(status.aheadCount, 0);
        assert.equal(status.behindCount, 0);
        assert.equal(status.aheadOfDefaultCount, 1);
      }),
    );

    it.effect("reports remote divergence without reading working-tree details", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["checkout", "-b", "feature/remote-status"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "feature.txt"]);
        yield* git(cwd, ["commit", "-m", "feature commit"]);
        yield* git(cwd, ["push", "-u", "origin", "feature/remote-status"]);
        yield* writeTextFile(cwd, "untracked.txt", "local-only\n");

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetailsRemote(cwd);

        assert.equal(status.isRepo, true);
        assert.equal(status.branch, "feature/remote-status");
        assert.equal(status.hasUpstream, true);
        assert.equal(status.aheadCount, 0);
        assert.equal(status.behindCount, 0);
        assert.equal(status.aheadOfDefaultCount, 1);
        assert.notProperty(status, "workingTree");
        assert.notProperty(status, "hasWorkingTreeChanges");
      }),
    );

    it.effect("can read cached remote divergence without fetching upstream", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const updater = yield* makeTmpDir("git-vcs-driver-updater-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);

        yield* git(updater, ["clone", remote, "."]);
        yield* git(updater, ["config", "user.email", "test@test.com"]);
        yield* git(updater, ["config", "user.name", "Test"]);
        yield* writeTextFile(updater, "remote.txt", "remote\n");
        yield* git(updater, ["add", "remote.txt"]);
        yield* git(updater, ["commit", "-m", "remote commit"]);
        yield* git(updater, ["push", "origin", initialBranch]);

        const driver = yield* GitVcsDriver.GitVcsDriver;
        const cachedStatus = yield* driver.statusDetailsRemote(cwd, {
          refreshUpstream: false,
        });
        const refreshedStatus = yield* driver.statusDetailsRemote(cwd);

        assert.equal(cachedStatus.behindCount, 0);
        assert.equal(refreshedStatus.behindCount, 1);
      }),
    );

    it.effect("uses origin HEAD for default-branch detection with a non-origin upstream", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const origin = yield* makeTmpDir("git-vcs-driver-origin-");
        const upstream = yield* makeTmpDir("git-vcs-driver-upstream-");
        yield* initRepoWithCommit(cwd);
        yield* git(origin, ["init", "--bare"]);
        yield* git(upstream, ["init", "--bare"]);
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(cwd, ["remote", "add", "origin", origin]);
        yield* git(cwd, ["remote", "add", "upstream", upstream]);
        yield* git(cwd, ["push", "origin", "main"]);
        yield* git(cwd, ["push", "upstream", "main"]);
        yield* git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
        yield* git(cwd, ["checkout", "-b", "release"]);
        yield* writeTextFile(cwd, "release.txt", "release\n");
        yield* git(cwd, ["add", "release.txt"]);
        yield* git(cwd, ["commit", "-m", "release commit"]);
        yield* git(cwd, ["push", "-u", "upstream", "release"]);
        yield* git(cwd, [
          "symbolic-ref",
          "refs/remotes/upstream/HEAD",
          "refs/remotes/upstream/release",
        ]);

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetailsRemote(cwd);

        assert.equal(status.branch, "release");
        assert.equal(status.upstreamRef, "upstream/release");
        assert.equal(status.isDefaultBranch, false);
      }),
    );

    it.effect("makes background upstream status fetches non-interactive", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const tempDir = yield* makeTmpDir("git-vcs-driver-ssh-env-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const sshLogPath = pathService.join(tempDir, "ssh-env.txt");
        const sshWrapperPath = pathService.join(tempDir, "ssh-wrapper.sh");
        const envKeys = [
          "GCM_INTERACTIVE",
          "GIT_ASKPASS",
          "GIT_SSH",
          "GIT_TERMINAL_PROMPT",
          "SSH_ASKPASS",
          "SSH_ASKPASS_REQUIRE",
          "T3_TEST_SSH_ASKPASS_LOG",
        ] as const;
        const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

        yield* fileSystem.writeFileString(
          sshWrapperPath,
          [
            "#!/bin/sh",
            'printf "GCM_INTERACTIVE=%s\\n" "${GCM_INTERACTIVE:-}" > "$T3_TEST_SSH_ASKPASS_LOG"',
            'printf "GIT_ASKPASS=%s\\n" "${GIT_ASKPASS:-}" >> "$T3_TEST_SSH_ASKPASS_LOG"',
            'printf "GIT_TERMINAL_PROMPT=%s\\n" "${GIT_TERMINAL_PROMPT:-}" >> "$T3_TEST_SSH_ASKPASS_LOG"',
            'printf "SSH_ASKPASS=%s\\n" "${SSH_ASKPASS:-}" >> "$T3_TEST_SSH_ASKPASS_LOG"',
            'printf "SSH_ASKPASS_REQUIRE=%s\\n" "${SSH_ASKPASS_REQUIRE:-}" >> "$T3_TEST_SSH_ASKPASS_LOG"',
            "exit 1",
            "",
          ].join("\n"),
        );
        yield* fileSystem.chmod(sshWrapperPath, 0o755);
        yield* git(cwd, ["remote", "add", "origin", "ssh://example.invalid/repo.git"]);
        yield* git(cwd, ["update-ref", `refs/remotes/origin/${initialBranch}`, "HEAD"]);
        yield* git(cwd, ["branch", "--set-upstream-to", `origin/${initialBranch}`]);

        yield* Effect.gen(function* () {
          process.env.GIT_SSH = sshWrapperPath;
          process.env.GCM_INTERACTIVE = "always";
          process.env.GIT_ASKPASS = "git-askpass";
          process.env.GIT_TERMINAL_PROMPT = "1";
          process.env.SSH_ASKPASS = "ssh-askpass";
          process.env.SSH_ASKPASS_REQUIRE = "force";
          process.env.T3_TEST_SSH_ASKPASS_LOG = sshLogPath;

          const refreshError = yield* (yield* GitVcsDriver.GitVcsDriver)
            .refreshStatusUpstream(cwd)
            .pipe(Effect.flip);

          assert.deepInclude(refreshError, {
            _tag: "GitCommandError",
            operation: "GitVcsDriver.fetchRemoteForStatus",
            cwd,
            detail: "Background Git fetch failed.",
          });
          assert.deepEqual((yield* fileSystem.readFileString(sshLogPath)).trim().split(/\r?\n/), [
            "GCM_INTERACTIVE=never",
            "GIT_ASKPASS=",
            "GIT_TERMINAL_PROMPT=0",
            "SSH_ASKPASS=",
            "SSH_ASKPASS_REQUIRE=never",
          ]);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              for (const key of envKeys) {
                const previous = previousEnv.get(key);
                if (previous === undefined) {
                  delete process.env[key];
                } else {
                  process.env[key] = previous;
                }
              }
            }),
          ),
        );
      }),
    );

    it.effect("fetches status remotes from the worktree with hardened background flags", () =>
      Effect.gen(function* () {
        const platform = yield* HostProcessPlatform;
        if (platform === "win32") return;

        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const wrapperDir = yield* makeTmpDir("git-vcs-driver-wrapper-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const realGit = yield* findGitExecutable();
        const wrapperPath = pathService.join(wrapperDir, "git");
        const invocationLogPath = pathService.join(wrapperDir, "fetch-invocation.txt");
        const fetchHeadPath = pathService.join(cwd, ".git", "FETCH_HEAD");
        const previousPath = process.env.PATH;
        const previousRealGit = process.env.T3_TEST_REAL_GIT;
        const previousInvocationLog = process.env.T3_TEST_FETCH_INVOCATION_LOG;

        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* fileSystem.writeFileString(fetchHeadPath, "sentinel-fetch-head\n");
        yield* fileSystem.writeFileString(
          wrapperPath,
          [
            "#!/bin/sh",
            "is_fetch=0",
            'for arg in "$@"; do',
            '  if [ "$arg" = "fetch" ]; then is_fetch=1; fi',
            "done",
            'if [ "$is_fetch" = "1" ]; then',
            '  printf "cwd=%s\\n" "$PWD" > "$T3_TEST_FETCH_INVOCATION_LOG"',
            '  for arg in "$@"; do',
            '    printf "arg=%s\\n" "$arg" >> "$T3_TEST_FETCH_INVOCATION_LOG"',
            "  done",
            "fi",
            'exec "$T3_TEST_REAL_GIT" "$@"',
            "",
          ].join("\n"),
        );
        yield* fileSystem.chmod(wrapperPath, 0o755);

        yield* Effect.gen(function* () {
          process.env.PATH = `${wrapperDir}:${previousPath ?? ""}`;
          process.env.T3_TEST_REAL_GIT = realGit;
          process.env.T3_TEST_FETCH_INVOCATION_LOG = invocationLogPath;

          yield* (yield* GitVcsDriver.GitVcsDriver).refreshStatusUpstream(cwd);

          assert.deepStrictEqual(
            (yield* fileSystem.readFileString(invocationLogPath)).trim().split(/\r?\n/),
            [
              `cwd=${cwd}`,
              "arg=fetch",
              "arg=--quiet",
              "arg=--no-tags",
              "arg=--no-write-fetch-head",
              "arg=--no-auto-maintenance",
              "arg=--no-recurse-submodules",
              "arg=--",
              "arg=origin",
            ],
          );
          assert.equal(yield* fileSystem.readFileString(fetchHeadPath), "sentinel-fetch-head\n");
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (previousPath === undefined) delete process.env.PATH;
              else process.env.PATH = previousPath;
              if (previousRealGit === undefined) delete process.env.T3_TEST_REAL_GIT;
              else process.env.T3_TEST_REAL_GIT = previousRealGit;
              if (previousInvocationLog === undefined) {
                delete process.env.T3_TEST_FETCH_INVOCATION_LOG;
              } else {
                process.env.T3_TEST_FETCH_INVOCATION_LOG = previousInvocationLog;
              }
            }),
          ),
        );
      }),
    );

    it.effect("coalesces matching refreshes and serializes different remotes sharing objects", () =>
      Effect.gen(function* () {
        const platform = yield* HostProcessPlatform;
        if (platform === "win32") return;

        const cwd = yield* makeTmpDir();
        const origin = yield* makeTmpDir("git-vcs-driver-origin-");
        const backup = yield* makeTmpDir("git-vcs-driver-backup-");
        const worktreeParent = yield* makeTmpDir("git-vcs-driver-worktrees-");
        const wrapperDir = yield* makeTmpDir("git-vcs-driver-wrapper-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const worktreeCwd = pathService.join(worktreeParent, "feature");
        const realGit = yield* findGitExecutable();
        const wrapperPath = pathService.join(wrapperDir, "git");
        const invocationLogPath = pathService.join(wrapperDir, "fetches.txt");
        const activeLockPath = pathService.join(wrapperDir, "active-fetch");
        const overlapLogPath = pathService.join(wrapperDir, "overlap.txt");
        const previousPath = process.env.PATH;
        const previousRealGit = process.env.T3_TEST_REAL_GIT;
        const previousInvocationLog = process.env.T3_TEST_FETCH_INVOCATION_LOG;
        const previousActiveLock = process.env.T3_TEST_FETCH_ACTIVE_LOCK;
        const previousOverlapLog = process.env.T3_TEST_FETCH_OVERLAP_LOG;

        yield* git(origin, ["init", "--bare"]);
        yield* git(backup, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", origin]);
        yield* git(cwd, ["remote", "add", "backup", backup]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["worktree", "add", "-b", "feature/serialized", worktreeCwd]);
        yield* git(worktreeCwd, ["push", "-u", "backup", "feature/serialized"]);
        yield* fileSystem.writeFileString(
          wrapperPath,
          [
            "#!/bin/sh",
            "is_fetch=0",
            'for arg in "$@"; do',
            '  if [ "$arg" = "fetch" ]; then is_fetch=1; fi',
            "done",
            'if [ "$is_fetch" = "1" ]; then',
            '  printf "start\\n" >> "$T3_TEST_FETCH_INVOCATION_LOG"',
            '  if ! mkdir "$T3_TEST_FETCH_ACTIVE_LOCK" 2>/dev/null; then',
            '    printf "overlap\\n" >> "$T3_TEST_FETCH_OVERLAP_LOG"',
            "  fi",
            "  sleep 0.2",
            '  "$T3_TEST_REAL_GIT" "$@"',
            "  status=$?",
            '  rmdir "$T3_TEST_FETCH_ACTIVE_LOCK" 2>/dev/null || true',
            '  printf "end\\n" >> "$T3_TEST_FETCH_INVOCATION_LOG"',
            "  exit $status",
            "fi",
            'exec "$T3_TEST_REAL_GIT" "$@"',
            "",
          ].join("\n"),
        );
        yield* fileSystem.chmod(wrapperPath, 0o755);

        yield* Effect.gen(function* () {
          process.env.PATH = `${wrapperDir}:${previousPath ?? ""}`;
          process.env.T3_TEST_REAL_GIT = realGit;
          process.env.T3_TEST_FETCH_INVOCATION_LOG = invocationLogPath;
          process.env.T3_TEST_FETCH_ACTIVE_LOCK = activeLockPath;
          process.env.T3_TEST_FETCH_OVERLAP_LOG = overlapLogPath;

          const driver = yield* GitVcsDriver.GitVcsDriver;
          yield* Effect.all(
            [
              driver.refreshStatusUpstream(cwd),
              driver.refreshStatusUpstream(cwd),
              driver.refreshStatusUpstream(worktreeCwd),
            ],
            { concurrency: "unbounded", discard: true },
          );

          const invocationLines = (yield* fileSystem.readFileString(invocationLogPath))
            .trim()
            .split(/\r?\n/);
          assert.deepStrictEqual(invocationLines, ["start", "end", "start", "end"]);
          assert.equal(yield* fileSystem.exists(overlapLogPath), false);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (previousPath === undefined) delete process.env.PATH;
              else process.env.PATH = previousPath;
              if (previousRealGit === undefined) delete process.env.T3_TEST_REAL_GIT;
              else process.env.T3_TEST_REAL_GIT = previousRealGit;
              if (previousInvocationLog === undefined) {
                delete process.env.T3_TEST_FETCH_INVOCATION_LOG;
              } else {
                process.env.T3_TEST_FETCH_INVOCATION_LOG = previousInvocationLog;
              }
              if (previousActiveLock === undefined) delete process.env.T3_TEST_FETCH_ACTIVE_LOCK;
              else process.env.T3_TEST_FETCH_ACTIVE_LOCK = previousActiveLock;
              if (previousOverlapLog === undefined) delete process.env.T3_TEST_FETCH_OVERLAP_LOG;
              else process.env.T3_TEST_FETCH_OVERLAP_LOG = previousOverlapLog;
            }),
          ),
        );
      }),
    );

    it.effect("keeps a waiting worktree refresh alive when the cache owner disconnects", () =>
      Effect.gen(function* () {
        const platform = yield* HostProcessPlatform;
        if (platform === "win32") return;

        const cwd = yield* makeTmpDir();
        const origin = yield* makeTmpDir("git-vcs-driver-origin-");
        const worktreeParent = yield* makeTmpDir("git-vcs-driver-worktrees-");
        const wrapperDir = yield* makeTmpDir("git-vcs-driver-wrapper-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const worktreeCwd = pathService.join(worktreeParent, "feature");
        const realGit = yield* findGitExecutable();
        const wrapperPath = pathService.join(wrapperDir, "git");
        const invocationLogPath = pathService.join(wrapperDir, "fetches.txt");
        const ownerLockPath = pathService.join(wrapperDir, "owner-fetch");
        const ownerStartedPath = pathService.join(wrapperDir, "owner-started");
        const waiterReadyPath = pathService.join(wrapperDir, "waiter-ready");
        const envKeys = [
          "PATH",
          "T3_TEST_REAL_GIT",
          "T3_TEST_FETCH_INVOCATION_LOG",
          "T3_TEST_FETCH_OWNER_LOCK",
          "T3_TEST_FETCH_OWNER_STARTED",
          "T3_TEST_FETCH_WAITER_CWD",
          "T3_TEST_FETCH_WAITER_READY",
        ] as const;
        const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

        yield* git(origin, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", origin]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["worktree", "add", "-b", "feature/interrupted", worktreeCwd]);
        yield* git(worktreeCwd, ["push", "-u", "origin", "feature/interrupted"]);
        yield* fileSystem.writeFileString(
          wrapperPath,
          [
            "#!/bin/sh",
            "is_fetch=0",
            "is_common_dir=0",
            'for arg in "$@"; do',
            '  if [ "$arg" = "fetch" ]; then is_fetch=1; fi',
            '  if [ "$arg" = "--git-common-dir" ]; then is_common_dir=1; fi',
            "done",
            'if [ "$is_fetch" = "1" ]; then',
            '  printf "start:%s\\n" "$PWD" >> "$T3_TEST_FETCH_INVOCATION_LOG"',
            '  if mkdir "$T3_TEST_FETCH_OWNER_LOCK" 2>/dev/null; then',
            '    : > "$T3_TEST_FETCH_OWNER_STARTED"',
            "    trap 'exit 130' INT TERM HUP",
            "    while :; do sleep 1; done",
            "  fi",
            '  exec "$T3_TEST_REAL_GIT" "$@"',
            "fi",
            '"$T3_TEST_REAL_GIT" "$@"',
            "status=$?",
            'if [ "$PWD" = "$T3_TEST_FETCH_WAITER_CWD" ] && [ "$is_common_dir" = "1" ]; then',
            '  : > "$T3_TEST_FETCH_WAITER_READY"',
            "fi",
            "exit $status",
            "",
          ].join("\n"),
        );
        yield* fileSystem.chmod(wrapperPath, 0o755);

        yield* Effect.gen(function* () {
          process.env.PATH = `${wrapperDir}:${previousEnv.get("PATH") ?? ""}`;
          process.env.T3_TEST_REAL_GIT = realGit;
          process.env.T3_TEST_FETCH_INVOCATION_LOG = invocationLogPath;
          process.env.T3_TEST_FETCH_OWNER_LOCK = ownerLockPath;
          process.env.T3_TEST_FETCH_OWNER_STARTED = ownerStartedPath;
          process.env.T3_TEST_FETCH_WAITER_CWD = worktreeCwd;
          process.env.T3_TEST_FETCH_WAITER_READY = waiterReadyPath;

          const waitForFile = (filePath: string) =>
            Effect.gen(function* () {
              while (!(yield* fileSystem.exists(filePath))) {
                yield* Effect.sleep("10 millis");
              }
            }).pipe(Effect.timeout("2 seconds"));
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const owner = yield* driver.refreshStatusUpstream(cwd).pipe(Effect.forkChild);
          yield* waitForFile(ownerStartedPath);

          const waiter = yield* driver.refreshStatusUpstream(worktreeCwd).pipe(Effect.forkChild);
          yield* waitForFile(waiterReadyPath);
          yield* Effect.sleep("50 millis");
          yield* Fiber.interrupt(owner);
          yield* Fiber.join(waiter).pipe(Effect.timeout("5 seconds"));

          assert.deepStrictEqual(
            (yield* fileSystem.readFileString(invocationLogPath)).trim().split(/\r?\n/),
            [`start:${cwd}`, `start:${worktreeCwd}`],
          );
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              for (const key of envKeys) {
                const previous = previousEnv.get(key);
                if (previous === undefined) delete process.env[key];
                else process.env[key] = previous;
              }
            }),
          ),
          TestClock.withLive,
        );
      }),
    );

    it.effect("reuses the no-upstream fallback ahead count for default-branch delta", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["checkout", "-b", "feature/no-upstream"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "feature.txt"]);
        yield* git(cwd, ["commit", "-m", "feature commit"]);

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.hasUpstream, false);
        assert.equal(status.aheadCount, 1);
        assert.equal(status.behindCount, 0);
        assert.equal(status.aheadOfDefaultCount, 1);
      }),
    );
  });

  describe("refName operations", () => {
    it.effect("optionally includes remote refs that match local branches", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const deduplicated = yield* driver.listRefs({ cwd });
        assert.equal(
          deduplicated.refs.some((ref) => ref.name === `origin/${initialBranch}`),
          false,
        );

        const complete = yield* driver.listRefs({ cwd, includeMatchingRemoteRefs: true });
        assert.equal(
          complete.refs.some((ref) => ref.name === initialBranch),
          true,
        );
        assert.equal(
          complete.refs.some((ref) => ref.name === `origin/${initialBranch}`),
          true,
        );

        const remoteOnly = yield* driver.listRefs({
          cwd,
          includeMatchingRemoteRefs: true,
          refKind: "remote",
          limit: 1,
        });
        assert.equal(remoteOnly.refs.length, 1);
        assert.equal(remoteOnly.refs[0]?.name, `origin/${initialBranch}`);
        assert.equal(remoteOnly.refs[0]?.isRemote, true);
      }),
    );

    it.effect("creates, checks out, renames, and lists refs", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* driver.createRef({ cwd, refName: "feature/original" });
        const switchRef = yield* driver.switchRef({ cwd, refName: "feature/original" });
        assert.equal(switchRef.refName, "feature/original");

        const renamed = yield* driver.renameBranch({
          cwd,
          oldBranch: "feature/original",
          newBranch: "feature/renamed",
        });
        assert.equal(renamed.branch, "feature/renamed");
        assert.equal(yield* git(cwd, ["branch", "--show-current"]), "feature/renamed");

        const refs = yield* driver.listRefs({ cwd });
        assert.equal(
          refs.refs.find((refName) => refName.name === "feature/renamed")?.current,
          true,
        );
      }),
    );

    it.effect("returns the existing refName when rename source and target match", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const current = yield* git(cwd, ["branch", "--show-current"]);
        const result = yield* driver.renameBranch({
          cwd,
          oldBranch: current,
          newBranch: current,
        });

        assert.equal(result.branch, current);
      }),
    );
  });

  describe("worktree operations", () => {
    it.effect("creates and removes a worktree for a new refName", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "feature-worktree",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const created = yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/worktree",
        });

        assert.equal(created.worktree.path, worktreePath);
        assert.equal(created.worktree.refName, "feature/worktree");
        assert.equal(yield* git(worktreePath, ["branch", "--show-current"]), "feature/worktree");

        yield* driver.removeWorktree({ cwd, path: worktreePath });
        const fileSystem = yield* FileSystem.FileSystem;
        assert.equal(yield* fileSystem.exists(worktreePath), false);
      }),
    );
  });

  describe("commit context", () => {
    it.effect("stages selected files and commits only those files", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* writeTextFile(cwd, "a.txt", "a\n");
        yield* writeTextFile(cwd, "b.txt", "b\n");

        const context = yield* driver.prepareCommitContext(cwd, ["a.txt"]);
        assert.include(context?.stagedSummary ?? "", "a.txt");
        assert.notInclude(context?.stagedSummary ?? "", "b.txt");

        const commit = yield* driver.commit(cwd, "Add a", "");
        assert.match(commit.commitSha, /^[a-f0-9]{40}$/);
        assert.equal(yield* git(cwd, ["log", "-1", "--pretty=%s"]), "Add a");

        const status = yield* git(cwd, ["status", "--porcelain"]);
        assert.include(status, "?? b.txt");
        assert.notInclude(status, "a.txt");
      }),
    );
  });

  describe("remote operations", () => {
    it.effect("creates a worktree from the latest fetched remote commit", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        const peer = yield* makeTmpDir("git-peer-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(remote, ["symbolic-ref", "HEAD", `refs/heads/${initialBranch}`]);
        const beforeFetch = yield* git(cwd, ["rev-parse", `refs/remotes/origin/${initialBranch}`]);

        yield* git(peer, ["clone", remote, "."]);
        yield* git(peer, ["config", "user.email", "test@test.com"]);
        yield* git(peer, ["config", "user.name", "Test"]);
        yield* writeTextFile(peer, "remote-change.txt", "remote\n");
        yield* git(peer, ["add", "remote-change.txt"]);
        yield* git(peer, ["commit", "-m", "remote change"]);
        yield* git(peer, ["push", "origin", initialBranch]);
        const remoteHead = yield* git(peer, ["rev-parse", "HEAD"]);
        assert.notEqual(beforeFetch, remoteHead);

        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.fetchRemote({ cwd, remoteName: "origin" });

        const resolvedBase = yield* driver.resolveRemoteTrackingCommit({
          cwd,
          refName: initialBranch,
          fallbackRemoteName: "origin",
        });
        const explicitlyResolvedBase = yield* driver.resolveRemoteTrackingCommit({
          cwd,
          refName: `origin/${initialBranch}`,
          fallbackRemoteName: "origin",
        });

        assert.deepEqual(resolvedBase, {
          commitSha: remoteHead,
          remoteRefName: `origin/${initialBranch}`,
        });
        assert.deepEqual(explicitlyResolvedBase, resolvedBase);
        assert.equal(yield* git(cwd, ["rev-parse", initialBranch]), beforeFetch);

        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-fetched-worktrees-"),
          "fetched-origin",
        );
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: resolvedBase.commitSha,
          newRefName: "t3code/fetched-origin",
          baseRefName: resolvedBase.remoteRefName,
        });

        assert.equal(yield* git(worktreePath, ["rev-parse", "HEAD"]), remoteHead);
        assert.equal(
          yield* driver.readConfigValue(worktreePath, "branch.t3code/fetched-origin.gh-merge-base"),
          initialBranch,
        );
        assert.equal(
          yield* driver.readConfigValue(worktreePath, "branch.t3code/fetched-origin.remote"),
          null,
        );
        const status = yield* driver.statusDetails(worktreePath);
        assert.equal(status.aheadCount, 0);
        assert.equal(status.aheadOfDefaultCount, 0);
      }),
    );

    it.effect("pushes with upstream setup and skips when already up to date", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* (yield* GitVcsDriver.GitVcsDriver).createRef({
          cwd,
          refName: "feature/push",
        });
        yield* (yield* GitVcsDriver.GitVcsDriver).switchRef({
          cwd,
          refName: "feature/push",
        });
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* (yield* GitVcsDriver.GitVcsDriver).prepareCommitContext(cwd);
        yield* (yield* GitVcsDriver.GitVcsDriver).commit(cwd, "Add feature", "");

        const pushed = yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(cwd, null);
        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "feature/push",
          setUpstream: true,
        });
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
          "origin/feature/push",
        );

        const skipped = yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(cwd, null);
        assert.deepInclude(skipped, {
          status: "skipped_up_to_date",
          branch: "feature/push",
        });
      }),
    );

    it.effect(
      "pushes upstream branches to the remote branch name, not the upstream shorthand",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const remote = yield* makeTmpDir("git-remote-");
          yield* initRepoWithCommit(cwd);
          const driver = yield* GitVcsDriver.GitVcsDriver;
          yield* git(cwd, ["branch", "-M", "main"]);
          yield* git(remote, ["init", "--bare"]);
          yield* git(cwd, ["remote", "add", "origin", remote]);
          yield* git(cwd, ["push", "-u", "origin", "main"]);
          yield* writeTextFile(cwd, "upstream.txt", "upstream\n");
          yield* driver.prepareCommitContext(cwd);
          yield* driver.commit(cwd, "Add upstream update", "");

          const pushed = yield* driver.pushCurrentBranch(cwd, null);

          assert.deepInclude(pushed, {
            status: "pushed",
            branch: "main",
            upstreamBranch: "origin/main",
            setUpstream: false,
          });
          assert.equal(
            yield* git(remote, ["log", "-1", "--pretty=%s", "main"]),
            "Add upstream update",
          );
          const badBranch = yield* driver.execute({
            operation: "GitVcsDriver.test.showBadRemoteBranch",
            cwd: remote,
            args: ["show-ref", "--verify", "--quiet", "refs/heads/origin/main"],
            allowNonZeroExit: true,
            timeoutMs: 10_000,
          });
          assert.notEqual(badBranch.exitCode, 0);
        }),
    );

    it.effect("pushes to the requested remote instead of the primary remote", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const originRemote = yield* makeTmpDir("git-origin-remote-");
        const publishRemote = yield* makeTmpDir("git-publish-remote-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(originRemote, ["init", "--bare"]);
        yield* git(publishRemote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", originRemote]);
        yield* git(cwd, ["remote", "add", "origin-1", publishRemote]);

        const pushed = yield* driver.pushCurrentBranch(cwd, null, { remoteName: "origin-1" });

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "main",
          upstreamBranch: "origin-1/main",
          setUpstream: true,
        });
        assert.equal(
          yield* git(publishRemote, ["log", "-1", "--pretty=%s", "main"]),
          "initial commit",
        );
        const originMain = yield* driver.execute({
          operation: "GitVcsDriver.test.originMainMissing",
          cwd: originRemote,
          args: ["show-ref", "--verify", "--quiet", "refs/heads/main"],
          allowNonZeroExit: true,
          timeoutMs: 10_000,
        });
        assert.notEqual(originMain.exitCode, 0);
      }),
    );
  });
});
