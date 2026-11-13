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
  layerServerConfig,
  makeSuccessfulHandle,
  makeFailedHandle,
  makeTmpDir,
  writeTextFile,
  git,
  remoteUrl,
  failedPush,
  leakedText,
  failWith,
} from "./GitVcsDriverCore-fixtures.testkit.ts";

it.effect("lets a worktree checkout that is still working run past five minutes", () =>
  Effect.gen(function* () {
    const checkoutStarted = yield* Deferred.make<void>();
    const checkoutFinished = yield* Deferred.make<void>();
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (!ChildProcess.isStandardCommand(command))
          return yield* Effect.die("expected Git command");
        if (!command.args.includes("worktree")) return makeSuccessfulHandle("");
        yield* Deferred.succeed(checkoutStarted, undefined);
        return ChildProcessSpawner.makeHandle({
          ...makeSuccessfulHandle(""),
          exitCode: Deferred.await(checkoutFinished).pipe(
            Effect.as(ChildProcessSpawner.ExitCode(0)),
          ),
          stderr: Stream.encodeText(
            Stream.concat(
              Stream.make("Updating files:  40% (49052/122629)\n"),
              Stream.fromEffect(
                Deferred.await(checkoutFinished).pipe(
                  Effect.as("Updating files: 100% (122629/122629), done.\n"),
                ),
              ),
            ),
          ),
        });
      }),
    );
    const driver = yield* makeGitVcsDriverCore().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const path = yield* Path.Path;
    const cwd = yield* makeTmpDir();
    const worktreePath = path.join(cwd, "worktree");

    const creation = yield* driver
      .createWorktree({ cwd, refName: "main", newRefName: "t3/slow-checkout", path: worktreePath })
      .pipe(Effect.forkChild);
    yield* Deferred.await(checkoutStarted);
    yield* TestClock.adjust("6 minutes");
    yield* Deferred.succeed(checkoutFinished, undefined);

    const result = yield* Fiber.join(creation);
    assert.equal(result.worktree.path, worktreePath);
    assert.equal(result.worktree.refName, "t3/slow-checkout");
  }).pipe(
    Effect.provide(
      layerServerConfig.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);
it.effect("cancels a slow submodule checkout without reporting best-effort success", () =>
  Effect.gen(function* () {
    const updateStarted = yield* Deferred.make<void>();
    const updateStopped = yield* Deferred.make<void>();
    const finished = yield* Ref.make<ReadonlyArray<{ ok: boolean; detail: string | null }>>([]);
    const claimed = yield* Ref.make<string | null>(null);
    const spawner = ChildProcessSpawner.make((command) => {
      if (
        ChildProcess.isStandardCommand(command) &&
        command.args[0] === "submodule" &&
        command.args[1] === "update"
      ) {
        return Effect.acquireRelease(
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              ...makeSuccessfulHandle(""),
              exitCode: Deferred.succeed(updateStarted, undefined).pipe(
                Effect.andThen(Effect.never),
              ),
            }),
          ),
          () => Deferred.succeed(updateStopped, undefined),
        );
      }
      return Effect.succeed(makeSuccessfulHandle(""));
    });
    const driver = yield* makeGitVcsDriverCore().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const cwd = yield* makeTmpDir();
    const path = yield* Path.Path;
    const worktreePath = path.join(cwd, "worktree");
    yield* writeTextFile(worktreePath, ".gitmodules", "");
    const creation = yield* driver
      .createWorktree(
        { cwd, refName: "main", newRefName: "bugfix/cancel-submodules", path: worktreePath },
        {
          progress: {
            onWorktreeClaimed: (value) => Ref.set(claimed, value),
            onSubmodulesFinished: (result) => Ref.update(finished, (items) => [...items, result]),
          },
        },
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(updateStarted);
    yield* TestClock.adjust("6 minutes");
    yield* Fiber.interrupt(creation);
    const exit = yield* Fiber.await(creation);
    assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
    assert.isTrue(yield* Deferred.isDone(updateStopped));
    assert.equal(yield* Ref.get(claimed), worktreePath);
    assert.isEmpty(yield* Ref.get(finished));
  }).pipe(
    Effect.provide(
      layerServerConfig.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);
describe("rejected git refs", () => {
  const remoteUrl = "https://user:token-123@git.example.invalid/org/secret-repo.git";
  const failedPush = `error: failed to push some refs to '${remoteUrl}'`;
  const leakedText = [
    "token-123",
    "secret-repo",
    "git.example.invalid",
    "private-branch",
    "workflow scope",
  ];

  const failWith = (stderr: string) => {
    const spawner = ChildProcessSpawner.make(() => Effect.succeed(makeFailedHandle(stderr)));
    const layer = GitVcsDriver.layer.pipe(
      Layer.provide(layerServerConfig),
      Layer.provideMerge(
        Layer.merge(
          Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
    );
    return Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      return yield* driver
        .execute({
          operation: "GitVcsDriver.test.rejectedRef",
          cwd: "/repo",
          args: ["push", "origin", "HEAD"],
        })
        .pipe(Effect.flip);
    }).pipe(Effect.provide(layer));
  };

  it.effect.each([
    {
      label: "a ref the remote refused",
      stderr: [
        "remote: Unable to determine if workflow can be created; workflow scope may be required.",
        `To ${remoteUrl}`,
        " ! [remote rejected] private-branch -> private-branch (workflow scope may be required.)",
        failedPush,
      ],
      reason: "push_rejected_by_remote" as const,
      detail: "The remote rejected the push.",
    },
    {
      label: "a non-fast-forward push",
      stderr: [
        `To ${remoteUrl}`,
        " ! [rejected]        private-branch -> private-branch (non-fast-forward)",
        failedPush,
      ],
      reason: "push_rejected_non_fast_forward" as const,
      detail: "Pull or rebase",
    },
  ])("names $label without quoting stderr", ({ stderr, reason, detail }) =>
    Effect.gen(function* () {
      const error = yield* failWith(stderr.join("\n"));

      assert.deepInclude(error, { reason });
      assert.include(error.detail, detail);
      for (const text of leakedText) assert.notInclude(error.message, text);
    }),
  );

  // A fetch into a diverged local branch prints the same rejected line, but
  // never "failed to push some refs".
  it.effect("leaves a rejected fetch unclassified", () =>
    Effect.gen(function* () {
      const error = yield* failWith(
        [`From ${remoteUrl}`, " ! [rejected]        main       -> side  (non-fast-forward)"].join(
          "\n",
        ),
      );

      assert.equal(error.reason, undefined);
      assert.equal(error.detail, "Git command exited with a non-zero status.");
    }),
  );
});
