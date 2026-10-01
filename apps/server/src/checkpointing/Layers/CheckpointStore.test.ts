import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer, Option, PlatformError, Scope } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect } from "vitest";

import { checkpointBaselineRefForThreadTurn, checkpointRefForThreadTurn } from "../Utils.ts";
import { CheckpointStoreLive } from "./CheckpointStore.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import {
  GitCore,
  type ExecuteGitInput,
  type ExecuteGitResult,
} from "../../git/Services/GitCore.ts";
import { CheckpointRef, GitCommandError, ThreadId } from "@t3tools/contracts";
import { ServerConfig } from "../../config.ts";
import { CheckoutCoordinator } from "../../git/CheckoutCoordinator.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-checkpoint-store-test-",
});
const GitCoreTestLayer = GitCoreLive.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provide(NodeServices.layer),
);
const CheckpointStoreTestLayer = CheckpointStoreLive.pipe(
  Layer.provide(GitCoreTestLayer),
  Layer.provide(NodeServices.layer),
);
const TestLayer = Layer.mergeAll(NodeServices.layer, GitCoreTestLayer, CheckpointStoreTestLayer);

function executeGitResult(code: number, stdout = ""): ExecuteGitResult {
  return {
    code,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function makeTmpDir(
  prefix = "checkpoint-store-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });
}

function writeTextFile(
  filePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(filePath, contents);
  });
}

function git(
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, GitCommandError, GitCore> {
  return Effect.gen(function* () {
    const gitCore = yield* GitCore;
    const result = yield* gitCore.execute({
      operation: "CheckpointStore.test.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });
}

function initRepoWithCommit(
  cwd: string,
): Effect.Effect<
  void,
  GitCommandError | PlatformError.PlatformError,
  GitCore | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const core = yield* GitCore;
    yield* core.initRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(path.join(cwd, "README.md"), "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
  });
}

function buildLargeText(lineCount = 5_000): string {
  return Array.from({ length: lineCount }, (_, index) => `line ${String(index).padStart(5, "0")}`)
    .join("\n")
    .concat("\n");
}

function buildOversizedSingleLine(): string {
  return `${"x".repeat(11_000_000)}\n`;
}

function buildNumberedLines(lineCount: number): string {
  return Array.from({ length: lineCount }, (_, index) => `line ${String(index)}`)
    .join("\n")
    .concat("\n");
}

function replaceLine(contents: string, lineIndex: number, replacement: string): string {
  const lines = contents.split("\n");
  lines[lineIndex] = replacement;
  return lines.join("\n");
}

describe("CheckpointStoreLive range resolution", () => {
  for (const phase of [
    "HEAD",
    "workspace tree",
    "index tree",
    "restore worktree",
    "restore index",
  ] as const) {
    it.effect(`excludes manual checkout operations during ${phase}`, () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const real = yield* GitCore;
        const checkpointRef = checkpointBaselineRefForThreadTurn(
          ThreadId.make("coordinated-store"),
          1,
        );
        yield* writeTextFile(path.join(cwd, "README.md"), "staged\n");
        yield* git(cwd, ["add", "README.md"]);
        yield* writeTextFile(path.join(cwd, "README.md"), "unstaged\n");
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let armed = false;
        const restoring = phase.startsWith("restore");
        const instrumentedGit = Layer.succeed(GitCore, {
          ...real,
          execute: (input) =>
            real.execute(input).pipe(
              Effect.tap(() => {
                const matches =
                  phase === "HEAD"
                    ? input.operation === "CheckpointStore.resolveHeadCommit"
                    : phase === "workspace tree"
                      ? input.args[0] === "write-tree" && input.env?.GIT_INDEX_FILE !== undefined
                      : phase === "index tree"
                        ? input.args[0] === "write-tree" && input.env?.GIT_INDEX_FILE === undefined
                        : phase === "restore worktree"
                          ? input.args[0] === "read-tree" && input.args[1] === "--reset"
                          : input.args[0] === "read-tree" && input.args.length === 2;
                return armed && matches
                  ? Deferred.succeed(entered, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                    )
                  : Effect.void;
              }),
            ),
        });
        yield* Effect.gen(function* () {
          const store = yield* CheckpointStore;
          const coordinator = yield* CheckoutCoordinator;
          if (restoring) {
            yield* store.captureCheckpoint({ cwd, checkpointRef });
            yield* writeTextFile(path.join(cwd, "README.md"), "later\n");
            yield* git(cwd, ["add", "README.md"]);
            yield* writeTextFile(path.join(cwd, "untracked.txt"), "remove me\n");
          }
          armed = true;
          const operation = yield* (
            restoring
              ? store.restoreCheckpoint({ cwd, checkpointRef })
              : store.captureCheckpoint({ cwd, checkpointRef })
          ).pipe(Effect.forkScoped);
          yield* Effect.gen(function* () {
            yield* Deferred.await(entered);
            let mutated = false;
            const manual = coordinator.tryWithCheckout(
              cwd,
              writeTextFile(path.join(cwd, "README.md"), "manual\n").pipe(
                Effect.andThen(git(cwd, ["add", "README.md"])),
                Effect.tap(() =>
                  Effect.sync(() => {
                    mutated = true;
                  }),
                ),
              ),
            );
            expect(Option.isNone(yield* manual)).toBe(true);
            expect(mutated).toBe(false);
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(operation);
            if (restoring) {
              const fs = yield* FileSystem.FileSystem;
              expect(yield* fs.readFileString(path.join(cwd, "README.md"))).toBe("unstaged\n");
              expect(yield* git(cwd, ["show", ":README.md"])).toBe("staged");
              expect(yield* fs.exists(path.join(cwd, "untracked.txt"))).toBe(false);
            } else {
              expect(yield* git(cwd, ["show", `${checkpointRef}:README.md`])).toBe("unstaged");
              const message = yield* git(cwd, ["show", "-s", "--format=%B", checkpointRef]);
              const indexTree = /^t3-index-tree=(.+)$/m.exec(message)?.[1];
              expect(indexTree).toBeDefined();
              expect(yield* git(cwd, ["show", `${indexTree}:README.md`])).toBe("staged");
              expect(yield* git(cwd, ["rev-parse", `${checkpointRef}^`])).toBe(
                yield* git(cwd, ["rev-parse", "HEAD"]),
              );
            }
            expect(Option.isSome(yield* manual)).toBe(true);
            expect(mutated).toBe(true);
          }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
        }).pipe(
          Effect.provide(
            CheckpointStoreLive.pipe(
              Layer.provide(instrumentedGit),
              Layer.provide(NodeServices.layer),
            ),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, GitCoreTestLayer))),
    );
  }

  it.effect("resolves preferred, fallback, and target checkpoint refs only once", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-checkpoint-store-range-resolution");
      const preferredFromCheckpointRef = checkpointBaselineRefForThreadTurn(threadId, 1);
      const fallbackFromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
      const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
      const executeInputs: Array<ExecuteGitInput> = [];
      const gitCoreLayer = Layer.mock(GitCore)({
        execute: (input) =>
          Effect.sync(() => {
            executeInputs.push(input);
            const revision = input.args[3];
            if (revision === `${preferredFromCheckpointRef}^{commit}`) {
              return executeGitResult(1);
            }
            if (revision === `${fallbackFromCheckpointRef}^{commit}`) {
              return executeGitResult(0, "from-oid\n");
            }
            if (revision === `${toCheckpointRef}^{commit}`) {
              return executeGitResult(0, "to-oid\n");
            }
            if (revision === "from-oid^" || revision === "to-oid^") {
              return executeGitResult(0, "base-oid\n");
            }
            if (input.args[0] === "diff") {
              return executeGitResult(0, "diff --git a/README.md b/README.md\n+# changed\n");
            }
            throw new Error(`Unexpected Git command: ${input.args.join(" ")}`);
          }),
      });
      const checkpointStoreLayer = CheckpointStoreLive.pipe(
        Layer.provide(gitCoreLayer),
        Layer.provide(NodeServices.layer),
      );
      const diff = yield* Effect.gen(function* () {
        const checkpointStore = yield* CheckpointStore;
        return yield* checkpointStore.diffCheckpoints({
          cwd: "/tmp/workspace",
          fromCheckpointRef: preferredFromCheckpointRef,
          fallbackFromCheckpointRef,
          toCheckpointRef,
        });
      }).pipe(Effect.provide(checkpointStoreLayer));

      const checkpointRefLookups = executeInputs
        .filter(
          (input) =>
            input.args[0] === "rev-parse" &&
            input.args[1] === "--verify" &&
            input.args[2] === "--quiet" &&
            input.args[3]?.startsWith("refs/t3/checkpoints/") === true,
        )
        .map((input) => input.args[3]);

      expect(checkpointRefLookups.toSorted()).toEqual(
        [
          `${preferredFromCheckpointRef}^{commit}`,
          `${fallbackFromCheckpointRef}^{commit}`,
          `${toCheckpointRef}^{commit}`,
        ].toSorted(),
      );
      expect(diff).toContain("+# changed");
    }),
  );

  it.effect("reuses base projection for the same immutable checkpoint pair", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-checkpoint-store-projection-cache-hit");
      const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
      const toCheckpointRef = checkpointRefForThreadTurn(threadId, 2);
      const executeInputs: Array<ExecuteGitInput> = [];
      const gitCoreLayer = Layer.mock(GitCore)({
        execute: (input) =>
          Effect.sync(() => {
            executeInputs.push(input);
            const revision = input.args[3];
            if (revision === `${fromCheckpointRef}^{commit}`) {
              return executeGitResult(0, "from-oid\n");
            }
            if (revision === `${toCheckpointRef}^{commit}`) {
              return executeGitResult(0, "to-oid\n");
            }
            if (revision === "from-oid^") {
              return executeGitResult(0, "from-base\n");
            }
            if (revision === "to-oid^") {
              return executeGitResult(0, "to-base\n");
            }
            if (input.args[0] === "reflog") {
              return executeGitResult(
                0,
                "to-base rebase (finish): returning to refs/heads/thread\nfrom-base commit: before\n",
              );
            }
            if (input.args[0] === "symbolic-ref") {
              return executeGitResult(0, "thread\n");
            }
            if (input.args[0] === "for-each-ref") {
              return executeGitResult(0, "foreign-tip\n");
            }
            if (input.args[0] === "rev-list" && input.args.includes("--parents")) {
              return executeGitResult(0, "to-base from-base\nfrom-base root\n");
            }
            if (input.args[0] === "rev-list") {
              return executeGitResult(0, "");
            }
            if (input.args[0] === "merge-base") {
              return executeGitResult(0, "from-base\n");
            }
            if (input.args[0] === "merge-tree") {
              return executeGitResult(0, "projected-tree\n");
            }
            if (input.args[0] === "diff") {
              return executeGitResult(0, "diff\n");
            }
            throw new Error(`Unexpected Git command: ${input.args.join(" ")}`);
          }),
      });
      const checkpointStoreLayer = CheckpointStoreLive.pipe(
        Layer.provide(gitCoreLayer),
        Layer.provide(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const checkpointStore = yield* CheckpointStore;
        const input = { cwd: "/tmp/workspace", fromCheckpointRef, toCheckpointRef };
        yield* checkpointStore.diffCheckpoints(input);
        yield* checkpointStore.diffCheckpointFiles(input);
      }).pipe(Effect.provide(checkpointStoreLayer));

      expect(executeInputs.filter((input) => input.args[0] === "reflog")).toHaveLength(1);
      expect(executeInputs.filter((input) => input.args[0] === "merge-tree")).toHaveLength(1);
    }),
  );

  it.effect("computes base projection separately for different immutable pairs", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-checkpoint-store-projection-cache-miss");
      const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
      const firstToCheckpointRef = checkpointRefForThreadTurn(threadId, 2);
      const secondToCheckpointRef = checkpointRefForThreadTurn(threadId, 3);
      const executeInputs: Array<ExecuteGitInput> = [];
      const gitCoreLayer = Layer.mock(GitCore)({
        execute: (input) =>
          Effect.sync(() => {
            executeInputs.push(input);
            const revision = input.args[3];
            if (revision === `${fromCheckpointRef}^{commit}`) {
              return executeGitResult(0, "from-oid\n");
            }
            if (revision === `${firstToCheckpointRef}^{commit}`) {
              return executeGitResult(0, "to-oid-1\n");
            }
            if (revision === `${secondToCheckpointRef}^{commit}`) {
              return executeGitResult(0, "to-oid-2\n");
            }
            if (revision === "from-oid^") {
              return executeGitResult(0, "from-base\n");
            }
            if (revision === "to-oid-1^" || revision === "to-oid-2^") {
              return executeGitResult(0, "to-base\n");
            }
            if (input.args[0] === "reflog") {
              return executeGitResult(
                0,
                "to-base rebase (finish): returning to refs/heads/thread\nfrom-base commit: before\n",
              );
            }
            if (input.args[0] === "symbolic-ref") {
              return executeGitResult(0, "thread\n");
            }
            if (input.args[0] === "for-each-ref") {
              return executeGitResult(0, "foreign-tip\n");
            }
            if (input.args[0] === "rev-list" && input.args.includes("--parents")) {
              return executeGitResult(0, "to-base from-base\nfrom-base root\n");
            }
            if (input.args[0] === "rev-list") {
              return executeGitResult(0, "");
            }
            if (input.args[0] === "merge-base") {
              return executeGitResult(0, "from-base\n");
            }
            if (input.args[0] === "merge-tree") {
              return executeGitResult(0, "projected-tree\n");
            }
            if (input.args[0] === "diff") {
              return executeGitResult(0, "diff\n");
            }
            throw new Error(`Unexpected Git command: ${input.args.join(" ")}`);
          }),
      });
      const checkpointStoreLayer = CheckpointStoreLive.pipe(
        Layer.provide(gitCoreLayer),
        Layer.provide(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const checkpointStore = yield* CheckpointStore;
        yield* checkpointStore.diffCheckpoints({
          cwd: "/tmp/workspace",
          fromCheckpointRef,
          toCheckpointRef: firstToCheckpointRef,
        });
        yield* checkpointStore.diffCheckpoints({
          cwd: "/tmp/workspace",
          fromCheckpointRef,
          toCheckpointRef: secondToCheckpointRef,
        });
      }).pipe(Effect.provide(checkpointStoreLayer));

      expect(executeInputs.filter((input) => input.args[0] === "reflog")).toHaveLength(2);
      expect(executeInputs.filter((input) => input.args[0] === "merge-tree")).toHaveLength(2);
    }),
  );

  it.effect("re-resolves mutable HEAD fallbacks instead of caching them as checkpoint pairs", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-checkpoint-store-projection-workspace");
      const missingFromCheckpointRef = checkpointBaselineRefForThreadTurn(threadId, 1);
      const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
      const executeInputs: Array<ExecuteGitInput> = [];
      let headLookupCount = 0;
      const gitCoreLayer = Layer.mock(GitCore)({
        execute: (input) =>
          Effect.sync(() => {
            executeInputs.push(input);
            const revision = input.args[3];
            if (revision === `${missingFromCheckpointRef}^{commit}`) {
              return executeGitResult(1);
            }
            if (revision === `${toCheckpointRef}^{commit}`) {
              return executeGitResult(0, "to-oid\n");
            }
            if (input.args[0] === "rev-parse" && input.args.at(-1) === "HEAD^{commit}") {
              headLookupCount += 1;
              return executeGitResult(0, `workspace-head-${headLookupCount}\n`);
            }
            if (input.args[0] === "diff") {
              return executeGitResult(0, "diff\n");
            }
            throw new Error(`Unexpected Git command: ${input.args.join(" ")}`);
          }),
      });
      const checkpointStoreLayer = CheckpointStoreLive.pipe(
        Layer.provide(gitCoreLayer),
        Layer.provide(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const checkpointStore = yield* CheckpointStore;
        const input = {
          cwd: "/tmp/workspace",
          fromCheckpointRef: missingFromCheckpointRef,
          toCheckpointRef,
          fallbackFromToHead: true,
        };
        yield* checkpointStore.diffCheckpoints(input);
        yield* checkpointStore.diffCheckpoints(input);
      }).pipe(Effect.provide(checkpointStoreLayer));

      expect(headLookupCount).toBe(2);
      expect(executeInputs.filter((input) => input.args[0] === "reflog")).toHaveLength(0);
    }),
  );
});

describe("CheckpointStoreLive diff cache", () => {
  function makeDiffCacheTestLayer(options?: {
    readonly diffResult?: string | ((input: ExecuteGitInput) => string);
    readonly missingFromCheckpoint?: boolean;
  }) {
    let diffCalls = 0;
    const gitCoreLayer = Layer.mock(GitCore)({
      execute: (input) =>
        Effect.sync(() => {
          const revision = input.args[3];
          if (revision?.endsWith("^{commit}") === true) {
            if (revision === "HEAD^{commit}") {
              return executeGitResult(0, "head-oid\n");
            }
            if (options?.missingFromCheckpoint === true && revision.includes("/from")) {
              return executeGitResult(1);
            }
            return executeGitResult(0, revision.includes("/from") ? "from-oid\n" : "to-oid\n");
          }
          if (revision === "from-oid^" || revision === "to-oid^") {
            return executeGitResult(0, "base-oid\n");
          }
          if (input.args[0] === "diff") {
            diffCalls += 1;
            return executeGitResult(
              0,
              typeof options?.diffResult === "function"
                ? options.diffResult(input)
                : (options?.diffResult ?? `diff-${diffCalls}\n`),
            );
          }
          throw new Error(`Unexpected Git command: ${input.args.join(" ")}`);
        }),
    });
    return {
      getDiffCalls: () => diffCalls,
      layer: CheckpointStoreLive.pipe(
        Layer.provide(gitCoreLayer),
        Layer.provide(NodeServices.layer),
      ),
    };
  }

  it.effect("reuses an exact immutable checkpoint-pair diff", () =>
    Effect.gen(function* () {
      const test = makeDiffCacheTestLayer();
      const input = {
        cwd: "/tmp/workspace",
        fromCheckpointRef: CheckpointRef.make("refs/t3/checkpoints/from"),
        toCheckpointRef: CheckpointRef.make("refs/t3/checkpoints/to"),
        paths: ["README.md"],
      };

      const [first, second] = yield* Effect.gen(function* () {
        const checkpointStore = yield* CheckpointStore;
        return [
          yield* checkpointStore.diffCheckpoints(input),
          yield* checkpointStore.diffCheckpoints({ ...input, paths: ["README.md"] }),
        ];
      }).pipe(Effect.provide(test.layer));

      expect(first).toBe("diff-1\n");
      expect(second).toBe(first);
      expect(test.getDiffCalls()).toBe(1);
    }),
  );

  it.effect("misses when an immutable checkpoint-pair cache key changes", () =>
    Effect.gen(function* () {
      const test = makeDiffCacheTestLayer();
      const baseInput = {
        cwd: "/tmp/workspace",
        fromCheckpointRef: CheckpointRef.make("refs/t3/checkpoints/from"),
        toCheckpointRef: CheckpointRef.make("refs/t3/checkpoints/to"),
      };

      yield* Effect.gen(function* () {
        const checkpointStore = yield* CheckpointStore;
        yield* checkpointStore.diffCheckpoints(baseInput);
        yield* checkpointStore.diffCheckpoints({ ...baseInput, ignoreWhitespace: true });
        yield* checkpointStore.diffCheckpoints({ ...baseInput, paths: ["README.md"] });
      }).pipe(Effect.provide(test.layer));

      expect(test.getDiffCalls()).toBe(3);
    }),
  );

  it.effect("does not cache diffs that fall back to the mutable workspace HEAD", () =>
    Effect.gen(function* () {
      const test = makeDiffCacheTestLayer({ missingFromCheckpoint: true });
      const input = {
        cwd: "/tmp/workspace",
        fromCheckpointRef: CheckpointRef.make("refs/t3/checkpoints/from"),
        toCheckpointRef: CheckpointRef.make("refs/t3/checkpoints/to"),
        fallbackFromToHead: true,
      };

      const [first, second] = yield* Effect.gen(function* () {
        const checkpointStore = yield* CheckpointStore;
        return [
          yield* checkpointStore.diffCheckpoints(input),
          yield* checkpointStore.diffCheckpoints(input),
        ];
      }).pipe(Effect.provide(test.layer));

      expect(first).toBe("diff-1\n");
      expect(second).toBe("diff-2\n");
      expect(test.getDiffCalls()).toBe(2);
    }),
  );

  it.effect("does not retain diff results that exceed the per-entry byte budget", () =>
    Effect.gen(function* () {
      const largeDiff = "x".repeat(129 * 1024);
      const test = makeDiffCacheTestLayer({ diffResult: largeDiff });
      const input = {
        cwd: "/tmp/workspace",
        fromCheckpointRef: CheckpointRef.make("refs/t3/checkpoints/from"),
        toCheckpointRef: CheckpointRef.make("refs/t3/checkpoints/to"),
      };

      yield* Effect.gen(function* () {
        const checkpointStore = yield* CheckpointStore;
        yield* checkpointStore.diffCheckpoints(input);
        yield* checkpointStore.diffCheckpoints(input);
      }).pipe(Effect.provide(test.layer));

      expect(test.getDiffCalls()).toBe(2);
    }),
  );

  it.effect("evicts oversized results without displacing retained small diffs", () =>
    Effect.gen(function* () {
      const largeDiff = "x".repeat(128 * 1024 + 1);
      const test = makeDiffCacheTestLayer({
        diffResult: (input) => (input.cwd === "/tmp/small" ? "small\n" : largeDiff),
      });
      const input = {
        cwd: "/tmp/small",
        fromCheckpointRef: CheckpointRef.make("refs/t3/checkpoints/from"),
        toCheckpointRef: CheckpointRef.make("refs/t3/checkpoints/to"),
      };

      yield* Effect.gen(function* () {
        const checkpointStore = yield* CheckpointStore;
        expect(yield* checkpointStore.diffCheckpoints(input)).toBe("small\n");
        for (let index = 0; index < 128; index += 1) {
          expect(
            yield* checkpointStore.diffCheckpoints({ ...input, cwd: `/tmp/large-${index}` }),
          ).toBe(largeDiff);
        }
        expect(yield* checkpointStore.diffCheckpoints(input)).toBe("small\n");
      }).pipe(Effect.provide(test.layer));

      expect(test.getDiffCalls()).toBe(129);
    }),
  );

  it.effect("retains the byte-budget boundary only until the 5-minute TTL", () =>
    Effect.gen(function* () {
      const diff = "x".repeat(128 * 1024);
      const test = makeDiffCacheTestLayer({ diffResult: diff });
      const input = {
        cwd: "/tmp/workspace",
        fromCheckpointRef: CheckpointRef.make("refs/t3/checkpoints/from"),
        toCheckpointRef: CheckpointRef.make("refs/t3/checkpoints/to"),
      };

      yield* Effect.gen(function* () {
        const checkpointStore = yield* CheckpointStore;
        expect(yield* checkpointStore.diffCheckpoints(input)).toBe(diff);
        yield* TestClock.adjust("4 minutes");
        expect(yield* checkpointStore.diffCheckpoints(input)).toBe(diff);
        expect(test.getDiffCalls()).toBe(1);
        yield* TestClock.adjust("1 minute");
        expect(yield* checkpointStore.diffCheckpoints(input)).toBe(diff);
        expect(test.getDiffCalls()).toBe(2);
      }).pipe(Effect.provide(test.layer));
    }),
  );
});

it.layer(TestLayer)("CheckpointStoreLive", (it) => {
  describe("checkpointRefMatchesWorkspace", () => {
    it.effect("rejects a baseline after the same worktree switches branches", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const checkpointRef = checkpointRefForThreadTurn(
          ThreadId.make("thread-checkpoint-store-branch-switch"),
          0,
        );

        yield* git(tmp, ["checkout", "-b", "feature"]);
        yield* writeTextFile(path.join(tmp, "feature.md"), "feature\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "feature"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });

        yield* git(tmp, ["checkout", "-b", "replacement", "HEAD^"]);

        expect(
          yield* checkpointStore.checkpointRefMatchesWorkspace({
            cwd: tmp,
            checkpointRef,
          }),
        ).toBe(false);
      }),
    );

    it.effect("rejects a baseline when dirty workspace contents change without moving HEAD", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const checkpointRef = checkpointRefForThreadTurn(
          ThreadId.make("thread-checkpoint-store-dirty-workspace"),
          0,
        );

        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });
        yield* writeTextFile(path.join(tmp, "README.md"), "# dirty\n");
        yield* writeTextFile(path.join(tmp, "untracked.md"), "untracked\n");

        expect(
          yield* checkpointStore.checkpointRefMatchesWorkspace({
            cwd: tmp,
            checkpointRef,
          }),
        ).toBe(false);
      }),
    );

    it.effect("rejects a baseline when only the staged workspace contents change", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const checkpointRef = checkpointRefForThreadTurn(
          ThreadId.make("thread-checkpoint-store-staged-workspace"),
          0,
        );

        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });
        yield* writeTextFile(path.join(tmp, "README.md"), "# staged\n");
        yield* git(tmp, ["add", "README.md"]);
        yield* writeTextFile(path.join(tmp, "README.md"), "# test\n");

        expect(
          yield* checkpointStore.checkpointRefMatchesWorkspace({
            cwd: tmp,
            checkpointRef,
          }),
        ).toBe(false);
      }),
    );
  });

  describe("restoreCheckpoint", () => {
    it.effect("restores staged, unstaged, and untracked workspace state separately", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const fileSystem = yield* FileSystem.FileSystem;
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const checkpointRef = checkpointRefForThreadTurn(
          ThreadId.make("thread-checkpoint-store-restore-staging"),
          0,
        );

        yield* writeTextFile(path.join(tmp, "README.md"), "# staged\n");
        yield* git(tmp, ["add", "README.md"]);
        yield* writeTextFile(path.join(tmp, "README.md"), "# unstaged\n");
        yield* writeTextFile(path.join(tmp, "untracked.md"), "untracked\n");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });

        yield* writeTextFile(path.join(tmp, "README.md"), "# changed\n");
        yield* git(tmp, ["add", "README.md"]);
        yield* git(tmp, ["clean", "-fd"]);

        expect(yield* checkpointStore.restoreCheckpoint({ cwd: tmp, checkpointRef })).toBe(true);
        expect(yield* git(tmp, ["show", ":README.md"])).toBe("# staged");
        expect(yield* fileSystem.readFileString(path.join(tmp, "README.md"))).toBe("# unstaged\n");
        expect(yield* fileSystem.readFileString(path.join(tmp, "untracked.md"))).toBe(
          "untracked\n",
        );
      }),
    );
  });

  describe("diffCheckpoints", () => {
    it.effect("honors ignoreWhitespace for whitespace-only changes", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-whitespace");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 2);

        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: fromCheckpointRef });
        yield* writeTextFile(path.join(tmp, "README.md"), "#    test\n");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: true,
        });

        expect(diff).toBe("");
      }),
    );

    it.effect("excludes same-branch fast-forward pull changes", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-fast-forward");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 2);

        yield* git(tmp, ["checkout", "-b", "thread-branch"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: fromCheckpointRef });
        const oldHead = yield* git(tmp, ["rev-parse", "HEAD"]);

        yield* git(tmp, ["checkout", "-b", "upstream-branch"]);
        yield* writeTextFile(path.join(tmp, "upstream-b.md"), "upstream b\n");
        yield* git(tmp, ["add", "upstream-b.md"]);
        yield* git(tmp, ["commit", "-m", "upstream change b"]);
        const upstreamHeadB = yield* git(tmp, ["rev-parse", "HEAD"]);
        yield* git(tmp, ["branch", "older-upstream-tip", upstreamHeadB]);
        yield* writeTextFile(path.join(tmp, "upstream-c.md"), "upstream c\n");
        yield* git(tmp, ["add", "upstream-c.md"]);
        yield* git(tmp, ["commit", "-m", "upstream change c"]);
        const upstreamHeadC = yield* git(tmp, ["rev-parse", "HEAD"]);

        yield* git(tmp, ["checkout", "thread-branch"]);
        yield* git(tmp, ["branch", "-D", "upstream-branch"]);
        yield* git(tmp, [
          "update-ref",
          "-m",
          "pull: Fast-forward",
          "refs/heads/thread-branch",
          upstreamHeadB,
          oldHead,
        ]);
        yield* git(tmp, ["read-tree", "--reset", "-u", upstreamHeadB]);
        yield* git(tmp, [
          "update-ref",
          "-m",
          "pull: Fast-forward",
          "refs/heads/thread-branch",
          upstreamHeadC,
          upstreamHeadB,
        ]);
        yield* git(tmp, ["read-tree", "--reset", "-u", upstreamHeadC]);
        yield* writeTextFile(path.join(tmp, "README.md"), "# turn change\n");
        yield* git(tmp, ["add", "README.md"]);
        yield* git(tmp, ["commit", "-m", "turn change"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
        });

        expect(diff).toContain("+# turn change");
        expect(diff).not.toContain("upstream-b.md");
        expect(diff).not.toContain("upstream-c.md");
        expect(diff).not.toContain("+upstream b");
        expect(diff).not.toContain("+upstream c");
      }),
    );

    it.effect("excludes base movement that entered the workspace during the turn", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const sharedPath = path.join(tmp, "shared.md");
        yield* writeTextFile(sharedPath, buildNumberedLines(30));
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "add shared"]);
        const baseBranch = yield* git(tmp, ["rev-parse", "--abbrev-ref", "HEAD"]);

        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-base-movement");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 2);

        yield* git(tmp, ["checkout", "-b", "thread-branch"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: fromCheckpointRef });

        // Another branch advances the base while the turn is running.
        yield* git(tmp, ["checkout", "-b", "other-branch", baseBranch]);
        yield* writeTextFile(sharedPath, replaceLine(buildNumberedLines(30), 1, "foreign change"));
        yield* git(tmp, ["commit", "-am", "foreign commit"]);

        // The turn commits its own work, then rebases onto the advanced base.
        yield* git(tmp, ["checkout", "thread-branch"]);
        yield* writeTextFile(sharedPath, replaceLine(buildNumberedLines(30), 25, "turn change"));
        yield* git(tmp, ["commit", "-am", "turn commit"]);
        yield* git(tmp, ["rebase", "other-branch"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
        });

        expect(diff).toContain("+turn change");
        expect(diff).not.toContain("+foreign change");
      }),
    );

    it.effect("keeps turn-authored commits that a stacked branch forked from mid-turn", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const sharedPath = path.join(tmp, "shared.md");
        yield* writeTextFile(sharedPath, buildNumberedLines(30));
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "add shared"]);
        const baseBranch = yield* git(tmp, ["rev-parse", "--abbrev-ref", "HEAD"]);

        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-stacked");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 2);

        yield* git(tmp, ["checkout", "-b", "thread-branch"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: fromCheckpointRef });

        const earlierContents = replaceLine(buildNumberedLines(30), 5, "earlier change");
        yield* writeTextFile(sharedPath, earlierContents);
        yield* git(tmp, ["commit", "-am", "first turn commit"]);

        // A branch forked from an intermediate turn commit does not contain the
        // turn's final commit, so reachability alone would read the commit it
        // points at as the base the turn started from.
        yield* git(tmp, ["branch", "stacked-branch"]);

        yield* writeTextFile(sharedPath, replaceLine(earlierContents, 25, "turn change"));
        yield* git(tmp, ["commit", "-am", "second turn commit"]);

        // Real base movement, so the reflog gate cannot mask the ref exclusions.
        yield* git(tmp, ["checkout", "-b", "other-branch", baseBranch]);
        yield* writeTextFile(sharedPath, replaceLine(buildNumberedLines(30), 1, "foreign change"));
        yield* git(tmp, ["commit", "-am", "foreign commit"]);
        yield* git(tmp, ["checkout", "thread-branch"]);
        yield* git(tmp, ["rebase", "other-branch"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
        });

        expect(diff).not.toContain("+foreign change");
        expect(diff).toContain("+turn change");
        expect(diff).toContain("+earlier change");
      }),
    );

    it.effect("keeps earlier turns' commits out of a diff whose base was rebased", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const sharedPath = path.join(tmp, "shared.md");
        yield* writeTextFile(sharedPath, buildNumberedLines(30));
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "add shared"]);
        const baseBranch = yield* git(tmp, ["rev-parse", "--abbrev-ref", "HEAD"]);

        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-rebased-base");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 2);

        // The thread already carries a committed earlier turn, so the rebase
        // rewrites thread history and the old base leaves the new base's chain.
        yield* git(tmp, ["checkout", "-b", "thread-branch"]);
        const earlierContents = replaceLine(buildNumberedLines(30), 5, "earlier change");
        yield* writeTextFile(sharedPath, earlierContents);
        yield* git(tmp, ["commit", "-am", "earlier turn commit"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: fromCheckpointRef });

        yield* git(tmp, ["checkout", "-b", "other-branch", baseBranch]);
        yield* writeTextFile(sharedPath, replaceLine(buildNumberedLines(30), 1, "foreign change"));
        yield* git(tmp, ["commit", "-am", "foreign commit"]);

        yield* git(tmp, ["checkout", "thread-branch"]);
        yield* writeTextFile(sharedPath, replaceLine(earlierContents, 25, "turn change"));
        yield* git(tmp, ["commit", "-am", "turn commit"]);
        yield* git(tmp, ["rebase", "other-branch"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
        });

        expect(diff).toContain("+turn change");
        expect(diff).not.toContain("+foreign change");
        expect(diff).not.toContain("+earlier change");
      }),
    );

    it.effect("keeps foreign commits out of a diff whose base switched branches", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const sharedPath = path.join(tmp, "shared.md");
        yield* writeTextFile(sharedPath, buildNumberedLines(30));
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "add shared"]);
        const baseBranch = yield* git(tmp, ["rev-parse", "--abbrev-ref", "HEAD"]);

        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-checkout-base");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 2);

        yield* git(tmp, ["checkout", "-b", "thread-branch"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: fromCheckpointRef });

        // Foreign work lands on another branch (e.g. the base moves forward
        // while the turn is running).
        yield* git(tmp, ["checkout", "-b", "other-branch", baseBranch]);
        const foreignContents = replaceLine(buildNumberedLines(30), 1, "foreign change");
        yield* writeTextFile(sharedPath, foreignContents);
        yield* git(tmp, ["commit", "-am", "foreign commit"]);

        // The workspace switches to a branch that already contains the foreign
        // work — no rebase/merge/pull in the turn window, only a checkout —
        // then authors the turn change on top.
        yield* git(tmp, ["checkout", "-b", "moved-branch", "other-branch"]);
        yield* writeTextFile(sharedPath, replaceLine(foreignContents, 25, "turn change"));
        yield* git(tmp, ["commit", "-am", "turn commit"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
        });

        expect(diff).toContain("+turn change");
        expect(diff).not.toContain("+foreign change");

        const files = yield* checkpointStore.diffCheckpointFiles({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
        });
        const shared = files.find((file) => file.path === "shared.md");
        expect(shared?.additions).toBe(1);
        expect(shared?.deletions).toBe(1);
      }),
    );

    it.effect("keeps turn-authored commits that a mid-turn push left a remote ref on", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const sharedPath = path.join(tmp, "shared.md");
        yield* writeTextFile(sharedPath, buildNumberedLines(30));
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "add shared"]);
        const baseBranch = yield* git(tmp, ["rev-parse", "--abbrev-ref", "HEAD"]);

        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-pushed");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 2);

        yield* git(tmp, ["checkout", "-b", "thread-branch"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: fromCheckpointRef });

        // Real base movement, so the reflog gate cannot mask the ref exclusions.
        yield* git(tmp, ["checkout", "-b", "other-branch", baseBranch]);
        yield* writeTextFile(sharedPath, replaceLine(buildNumberedLines(30), 1, "foreign change"));
        yield* git(tmp, ["commit", "-am", "foreign commit"]);
        yield* git(tmp, ["checkout", "thread-branch"]);
        yield* git(tmp, ["rebase", "other-branch"]);

        const pushedContents = replaceLine(
          replaceLine(buildNumberedLines(30), 1, "foreign change"),
          5,
          "pushed change",
        );
        yield* writeTextFile(sharedPath, pushedContents);
        yield* git(tmp, ["commit", "-am", "first turn commit"]);
        // A mid-turn push leaves the branch's remote-tracking ref on the turn's
        // own commit; that must not be read as the base the turn started from.
        const pushedCommit = yield* git(tmp, ["rev-parse", "HEAD"]);
        yield* git(tmp, ["update-ref", "refs/remotes/origin/thread-branch", pushedCommit]);

        yield* writeTextFile(sharedPath, replaceLine(pushedContents, 25, "turn change"));
        yield* git(tmp, ["commit", "-am", "second turn commit"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
        });

        expect(diff).not.toContain("+foreign change");
        expect(diff).toContain("+turn change");
        expect(diff).toContain("+pushed change");
      }),
    );

    it.effect("excludes a base the turn merged in mid-turn", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const sharedPath = path.join(tmp, "shared.md");
        yield* writeTextFile(sharedPath, buildNumberedLines(30));
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "add shared"]);
        const baseBranch = yield* git(tmp, ["rev-parse", "--abbrev-ref", "HEAD"]);

        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-merge");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 2);

        yield* git(tmp, ["checkout", "-b", "thread-branch"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: fromCheckpointRef });

        yield* git(tmp, ["checkout", "-b", "other-branch", baseBranch]);
        yield* writeTextFile(sharedPath, replaceLine(buildNumberedLines(30), 1, "foreign change"));
        yield* git(tmp, ["commit", "-am", "foreign commit"]);

        // A merge keeps the turn's history as its first parent, so the adopted
        // base is only reachable through the merge's second parent.
        yield* git(tmp, ["checkout", "thread-branch"]);
        yield* writeTextFile(sharedPath, replaceLine(buildNumberedLines(30), 25, "turn change"));
        yield* git(tmp, ["commit", "-am", "turn commit"]);
        yield* git(tmp, ["merge", "--no-edit", "other-branch"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
        });

        expect(diff).toContain("+turn change");
        expect(diff).not.toContain("+foreign change");
      }),
    );

    it.effect("ignores base movement from a later turn when diffing an earlier one", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const sharedPath = path.join(tmp, "shared.md");
        yield* writeTextFile(sharedPath, buildNumberedLines(30));
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "add shared"]);
        const baseBranch = yield* git(tmp, ["rev-parse", "--abbrev-ref", "HEAD"]);

        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-later-turn");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 2);

        yield* git(tmp, ["checkout", "-b", "thread-branch"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: fromCheckpointRef });

        // Turn 2 moves no base; a stacked branch forks between its commits.
        const earlierContents = replaceLine(buildNumberedLines(30), 5, "earlier change");
        yield* writeTextFile(sharedPath, earlierContents);
        yield* git(tmp, ["commit", "-am", "first turn commit"]);
        yield* git(tmp, ["branch", "stacked-branch"]);
        yield* writeTextFile(sharedPath, replaceLine(earlierContents, 25, "turn change"));
        yield* git(tmp, ["commit", "-am", "second turn commit"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });

        // Turn 3 rebases. Diffing turn 2 afterwards must not see that rebase.
        yield* git(tmp, ["checkout", "-b", "other-branch", baseBranch]);
        yield* writeTextFile(sharedPath, replaceLine(buildNumberedLines(30), 1, "foreign change"));
        yield* git(tmp, ["commit", "-am", "foreign commit"]);
        yield* git(tmp, ["checkout", "thread-branch"]);
        yield* git(tmp, ["rebase", "other-branch"]);

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
        });

        expect(diff).toContain("+turn change");
        expect(diff).toContain("+earlier change");
      }),
    );

    it.effect("returns full oversized checkpoint diffs without truncation", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(path.join(tmp, "README.md"), buildLargeText());
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
        });

        expect(diff).toContain("diff --git");
        expect(diff).not.toContain("[truncated]");
        expect(diff).toContain("+line 04999");
      }),
    );

    it.effect("limits checkpoint diffs to validated repo-relative paths", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-paths");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(path.join(tmp, "README.md"), "# changed\n");
        yield* writeTextFile(path.join(tmp, "other.md"), "# other\n");
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          paths: ["README.md", ":!other.md", "../outside.md"],
        });

        expect(diff).toContain("diff --git a/README.md b/README.md");
        expect(diff).not.toContain("other.md");
      }),
    );
  });

  describe("diffCheckpointFiles", () => {
    it.effect("preserves rename metadata for paths with spaces", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-rename-summary");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* git(tmp, ["mv", "README.md", "renamed file.md"]);
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const files = yield* checkpointStore.diffCheckpointFiles({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
        });

        expect(files).toEqual([
          {
            path: "renamed file.md",
            previousPath: "README.md",
            kind: "renamed",
            additions: 0,
            deletions: 0,
          },
        ]);
      }),
    );

    it.effect(
      "returns file summaries for checkpoint diffs whose patch exceeds the output limit",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          const checkpointStore = yield* CheckpointStore;
          const threadId = ThreadId.make("thread-checkpoint-store-large-file-summary");
          const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
          const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

          yield* checkpointStore.captureCheckpoint({
            cwd: tmp,
            checkpointRef: fromCheckpointRef,
          });
          yield* writeTextFile(path.join(tmp, "README.md"), buildOversizedSingleLine());
          yield* checkpointStore.captureCheckpoint({
            cwd: tmp,
            checkpointRef: toCheckpointRef,
          });

          const files = yield* checkpointStore.diffCheckpointFiles({
            cwd: tmp,
            fromCheckpointRef,
            toCheckpointRef,
          });

          expect(files).toEqual([
            {
              path: "README.md",
              previousPath: null,
              kind: "modified",
              additions: 1,
              deletions: 1,
            },
          ]);
        }),
    );
  });
});
