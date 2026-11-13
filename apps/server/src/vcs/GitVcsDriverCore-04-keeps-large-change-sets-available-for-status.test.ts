// @effect-diagnostics nodeBuiltinImport:off -- fixtures and tests use Node builtins
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it, describe } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner, CommandLine } from "effect/process";
import {
  GitCommandError,
  ReviewDiffPreviewInput,
  VcsRef,
  VcsListRefsResult,
  type ReviewDiffFileContentsInput,
  type ReviewDiffPreviewResult,
  type WorktreeSubmodules,
} from "@t3tools/contracts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as ServerConfig from "../config.ts";
import {
  makeGitVcsDriverCore,
  parseGitCheckoutProgressLine,
  splitNullSeparatedGitStdoutPaths,
  windowsLongPathConfigEnv,
} from "./GitVcsDriverCore.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { gitConfigEnv } from "./VcsProcess.ts";

import {
  encodeGitCommandError,
  layerServerConfig,
  layerTest,
  makeTmpDir,
  writeTextFile,
  git,
  initRepoWithCommit,
} from "./GitVcsDriverCore-fixtures.testkit.ts";

it.layer(layerTest)("GitVcsDriver core integration", (it) => {
  it.effect("keeps large change sets available for status and commit preparation", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* git(cwd, ["init"]);
      yield* git(cwd, ["config", "user.email", "test@test.com"]);
      yield* git(cwd, ["config", "user.name", "Test"]);
      const files = Array.from(
        { length: 6_000 },
        (_, index) => `file-${String(index).padStart(5, "0")}-${"x".repeat(160)}.txt`,
      );
      yield* Effect.forEach(files, (file) => fs.writeFileString(path.join(cwd, file), "before\n"), {
        concurrency: 16,
        discard: true,
      });
      yield* git(cwd, ["add", "."]);
      const unborn = yield* driver.statusDetailsLocal(cwd);
      assert.lengthOf(unborn.workingTree.files, files.length);
      assert.equal(unborn.workingTree.insertions, files.length);
      const initial = yield* driver.commit(cwd, "initial", "");
      assert.match(initial.commitSha, /^[a-f0-9]{40}$/);
      assert.isFalse((yield* driver.statusDetailsLocal(cwd)).hasWorkingTreeChanges);
      yield* Effect.forEach(files, (file) => fs.writeFileString(path.join(cwd, file), "after\n"), {
        concurrency: 16,
        discard: true,
      });
      const status = yield* driver.statusDetailsLocal(cwd);
      assert.isTrue(status.hasWorkingTreeChanges);
      assert.lengthOf(status.workingTree.files, files.length);
      assert.equal(status.workingTree.insertions, files.length);
      assert.equal(status.workingTree.deletions, files.length);
      const context = yield* driver.prepareCommitContext(cwd, undefined, { includePatch: false });
      assert.isNotNull(context);
      assert.isAbove(context!.stagedSummary.length, 1_000_000);
      assert.lengthOf(context!.stagedSummary.split("\n"), files.length);
    }),
  );
  describe("structured errors", () => {
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
        assert.notProperty(error, "reason");
      }),
    );

    // regression: #8645 name the cause of a failed git command
    it.effect("names the branch conflict behind a failed worktree add", () =>
      Effect.gen(function* () {
        const parent = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const cwd = pathService.join(parent, "repo");
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.makeDirectory(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* initRepoWithCommit(cwd);
        const firstWorktree = pathService.join(parent, "first");
        yield* git(cwd, ["worktree", "add", firstWorktree, "-b", "shared-branch"]);

        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.worktreeAddConflict",
            cwd,
            args: ["worktree", "add", pathService.join(parent, "second"), "shared-branch"],
            env: { LC_ALL: "C" },
          })
          .pipe(Effect.flip);

        assert.deepInclude(error, {
          _tag: "GitCommandError",
          operation: "GitVcsDriver.test.worktreeAddConflict",
          reason: "branch_checked_out_in_worktree",
        });
        assert.include(error.message, "(branch_checked_out_in_worktree)");
        assert.notInclude(error.message, firstWorktree);
      }),
    );

    // regression: #8645 name the cause of a failed git command
    it.effect("names a missing repository behind a failed command", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.notARepository",
            cwd,
            args: ["rev-parse", "--abbrev-ref", "HEAD"],
            env: { LC_ALL: "C" },
          })
          .pipe(Effect.flip);

        assert.deepInclude(error, {
          _tag: "GitCommandError",
          operation: "GitVcsDriver.test.notARepository",
          reason: "not_a_repository",
        });
        assert.include(error.message, "(not_a_repository)");
      }),
    );

    it.effect.each([
      { action: "worktree add", detail: "git worktree add failed" },
      { action: "worktree add -b", detail: "git worktree add failed" },
      { action: "switch", detail: "git checkout failed" },
    ])(
      "reports a missing ref during $action with stable, redacted diagnostics",
      ({ action, detail }) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          const path = yield* Path.Path;
          const refName = "private/deleted-base";
          const locales: Array<CommandLine.Word | undefined> = [];
          const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
          const spawner = ChildProcessSpawner.make((command) => {
            if (
              ChildProcess.isStandardCommand(command) &&
              (command.args.includes("worktree") ||
                command.args[0] === "branch" ||
                command.args[0] === "checkout")
            ) {
              locales.push(command.options.env?.LANGUAGE);
            }
            return delegate.spawn(command);
          });
          const driver = yield* makeGitVcsDriverCore().pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provide(layerServerConfig),
          );
          const error =
            action === "switch"
              ? yield* driver.switchRef({ cwd, refName }).pipe(Effect.flip)
              : yield* driver
                  .createWorktree({
                    cwd,
                    refName,
                    ...(action === "worktree add -b" ? { newRefName: "t3/new-thread" } : {}),
                    path: path.join(cwd, "worktree"),
                  })
                  .pipe(Effect.flip);

          assert.deepInclude(error, { _tag: "GitCommandError", detail, reason: "ref_not_found" });
          assert.include(error.message, `${detail} (ref_not_found)`);
          assert.notInclude(error.message, refName);
          assert.notInclude(yield* encodeGitCommandError(error), refName);
          assert.deepEqual(locales, ["C"]);
          assert.notProperty(error, "stderr");
          assert.notProperty(error, "args");
        }),
    );

    it.effect.each([
      // Git cannot tell a missing revision from a missing file in these.
      { label: "an argument that may be a path", args: ["log", "-1", "missing"] },
      {
        label: "a pathspec worded like a diagnostic",
        args: ["checkout", "HEAD", "--", "fatal: invalid reference: missing"],
      },
      // The tag exists; it names a tree, which git reports in the same words.
      {
        label: "a worktree from a non-commit",
        args: ["worktree", "add", "tree-worktree", "tree-tag"],
      },
    ])("leaves $label unclassified rather than calling it a missing ref", ({ args }) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* initRepoWithCommit(cwd);
        if (args.includes("tree-tag")) {
          yield* git(cwd, ["tag", "tree-tag", "HEAD^{tree}"]);
        }

        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.ambiguousMissingName",
            cwd,
            args,
            env: { LC_ALL: "C" },
          })
          .pipe(Effect.flip);

        assert.notProperty(error, "reason");
      }),
    );

    it.effect.each([
      {
        label: "a refused key",
        sshMessage: "git@example.invalid: Permission denied (publickey).",
        expectedReason: "authentication_failed" as const,
        expectedText: "(authentication_failed)",
      },
      {
        label: "a refused key among several methods",
        sshMessage: "git@example.invalid: Permission denied (publickey,password).",
        expectedReason: "authentication_failed" as const,
        expectedText: "(authentication_failed)",
      },
      {
        label: "a refused keyboard-interactive attempt",
        sshMessage: "git@example.invalid: Permission denied (keyboard-interactive).",
        expectedReason: "authentication_failed" as const,
        expectedText: "(authentication_failed)",
      },
      {
        label: "a rejected password",
        sshMessage: "Permission denied, please try again.",
        expectedReason: "authentication_failed" as const,
        expectedText: "(authentication_failed)",
      },
      {
        label: "an untrusted host key",
        sshMessage: "Host key verification failed.",
        expectedReason: "host_key_unverified" as const,
        expectedText: "(host_key_unverified)",
      },
    ])(
      "names $label rather than an unreachable remote",
      ({ sshMessage, expectedReason, expectedText }) =>
        Effect.gen(function* () {
          const parent = yield* makeTmpDir();
          const pathService = yield* Path.Path;
          const cwd = pathService.join(parent, "repo");
          const fileSystem = yield* FileSystem.FileSystem;
          const driver = yield* GitVcsDriver.GitVcsDriver;
          yield* fileSystem.makeDirectory(cwd);
          yield* initRepoWithCommit(cwd);
          yield* git(cwd, ["remote", "add", "origin", "git@example.invalid:owner/repo.git"]);
          const fakeSsh = pathService.join(parent, "fake-ssh");
          yield* writeTextFile(
            parent,
            "fake-ssh",
            `#!/bin/sh\necho "${sshMessage}" >&2\nexit 255\n`,
          );
          yield* fileSystem.chmod(fakeSsh, 0o755);

          const error = yield* driver
            .execute({
              operation: "GitVcsDriver.test.sshRefusal",
              cwd,
              args: ["fetch", "origin"],
              env: { LC_ALL: "C", GIT_SSH_COMMAND: fakeSsh },
            })
            .pipe(Effect.flip);

          assert.deepInclude(error, { reason: expectedReason });
          assert.include(error.message, expectedText);
        }),
    );

    it.effect("does not read a filesystem permission error as an ssh refusal", () =>
      Effect.gen(function* () {
        const parent = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const cwd = pathService.join(parent, "repo");
        const fileSystem = yield* FileSystem.FileSystem;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* fileSystem.makeDirectory(cwd);
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["remote", "add", "origin", "git@example.invalid:owner/repo.git"]);
        const fakeSsh = pathService.join(parent, "fake-ssh");
        yield* writeTextFile(
          parent,
          "fake-ssh",
          '#!/bin/sh\necho "fatal: cannot open backup file: Permission denied (os error 13)" >&2\nexit 255\n',
        );
        yield* fileSystem.chmod(fakeSsh, 0o755);

        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.osPermission",
            cwd,
            args: ["fetch", "origin"],
            env: { LC_ALL: "C", GIT_SSH_COMMAND: fakeSsh },
          })
          .pipe(Effect.flip);

        assert.notInclude(error.message, "(authentication_failed)");
      }),
    );

    it.effect("reads a hook-declined push from git's rejection line, not the hook's output", () =>
      Effect.gen(function* () {
        const parent = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const remote = pathService.join(parent, "origin.git");
        const cwd = pathService.join(parent, "work");
        const fileSystem = yield* FileSystem.FileSystem;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* fileSystem.makeDirectory(cwd);
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["init", "--bare", remote]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        const preReceive = pathService.join(remote, "hooks", "pre-receive");
        yield* writeTextFile(
          remote,
          "hooks/pre-receive",
          '#!/bin/sh\necho "authentication failed" >&2\necho "Permission denied (publickey)." >&2\necho "Host key verification failed." >&2\nexit 1\n',
        );
        yield* fileSystem.chmod(preReceive, 0o755);

        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.remoteHookOutput",
            cwd,
            args: ["push", "origin", "HEAD"],
            env: { LC_ALL: "C" },
          })
          .pipe(Effect.flip);

        assert.deepInclude(error, { reason: "push_rejected_by_remote" });
        assert.notInclude(error.message, "(authentication_failed)");
      }),
    );

    it.effect("leaves a tag collision unclassified rather than calling it a path", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["tag", "v1"]);

        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.tagCollision",
            cwd,
            args: ["tag", "v1"],
            env: { LC_ALL: "C" },
          })
          .pipe(Effect.flip);

        assert.notProperty(error, "reason");
        assert.notInclude(error.message, "(path_already_exists)");
      }),
    );

    it.effect("keeps line callbacks flowing past the output cap when asked", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const lines: Array<string> = [];
        const result = yield* driver.execute({
          operation: "GitVcsDriver.test.callbacksPastCap",
          cwd,
          args: [
            "-c",
            'alias.spew=!for i in $(seq 1 128); do printf "é%03d\\n" $i >&2; done; echo fatal: last line >&2',
            "spew",
          ],
          maxOutputBytes: 512,
          appendTruncationMarker: true,
          keepLineCallbacksAfterTruncation: true,
          progress: { onStderrLine: (line) => Effect.sync(() => void lines.push(line)) },
        });

        assert.isTrue(result.stderrTruncated);
        assert.isAtMost(result.stderr.length, 600);
        assert.equal(lines.length, 129);
        assert.equal(lines[0], "é001");
        assert.equal(lines[127], "é128");
        assert.equal(lines.at(-1), "fatal: last line");
        assert.isFalse(lines.some((line) => line.includes("\uFFFD")));
      }),
    );

    it.effect("recovers a structurally identified missing cwd as a non-repository", () =>
      Effect.gen(function* () {
        const parent = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const cwd = pathService.join(parent, "missing");
        const driver = yield* GitVcsDriver.GitVcsDriver;

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
  });
});
