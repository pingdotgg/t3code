import { GitManagerError, type GitStartCommitWorkflowInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  buildPatchForLogicalChangeUnits,
  formatLogicalChangeUnitsForModel,
  parseLogicalChangeUnits,
  summarizeLogicalChangeUnits,
} from "./LogicalCommitPatch.ts";

const PATCH_LIMIT = 2_000_000;

export const runLogicalCommitWorkflow = Effect.fn("LogicalCommitWorkflow.run")(
  function* (
    request: Pick<GitStartCommitWorkflowInput, "cwd" | "expectedBranch" | "scope">,
    backupRoot: string,
    generatePlan: (
      input: Omit<
        Parameters<ProviderTextGeneration["generateCommitPlan"]>[0],
        "modelSelection" | "policy"
      >,
    ) => ReturnType<ProviderTextGeneration["generateCommitPlan"]>,
  ) {
    const git = yield* GitVcsDriver.GitVcsDriver;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = request.cwd;
    const fail = (detail: string) =>
      new GitManagerError({ operation: "splitCommits", cwd, detail });
    const execute = (
      args: readonly string[],
      options: {
        env?: NodeJS.ProcessEnv;
        stdin?: string;
        allowNonZeroExit?: boolean;
      } = {},
    ) =>
      git.execute({
        operation: "LogicalCommitWorkflow.git",
        cwd,
        args: ["-c", "core.splitIndex=false", "-c", "splitIndex.sharedIndexExpire=never", ...args],
        env: { GIT_OPTIONAL_LOCKS: "0", ...options.env },
        ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
        ...(options.allowNonZeroExit ? { allowNonZeroExit: true } : {}),
        maxOutputBytes: PATCH_LIMIT,
      });
    const output = (args: readonly string[], options?: Parameters<typeof execute>[1]) =>
      execute(args, options).pipe(Effect.map((result) => result.stdout.trim()));
    const readBranch = () =>
      output(["symbolic-ref", "--quiet", "HEAD"], { allowNonZeroExit: true });
    const readWorkingTree = Effect.fn("LogicalCommitWorkflow.snapshot")(function* () {
      const prepared = yield* git.prepareCommitContext(
        cwd,
        request.scope.type === "branch" ? undefined : request.scope.filePaths,
        {
          binaryPatch: true,
          maxOutputBytes: PATCH_LIMIT,
        },
      );
      if (prepared?.stagedPatchTruncated)
        return yield* fail(`Logical commit snapshots support patches up to ${PATCH_LIMIT} bytes.`);
      return prepared?.stagedPatch ?? "";
    });
    const head = yield* output(["rev-parse", "HEAD"]);
    const branchRef = yield* readBranch();
    const branch = branchRef.replace(/^refs\/heads\//, "") || null;
    if (branch !== request.expectedBranch)
      return yield* fail("The branch changed. Reopen the commit dialog and try again.");
    if ((yield* output(["ls-files", "--unmerged", "-z"])) !== "")
      return yield* fail("Resolve merge conflicts before splitting commits.");
    if (
      yield* fs.exists(path.resolve(cwd, yield* output(["rev-parse", "--git-path", "MERGE_HEAD"])))
    )
      return yield* fail("Finish the merge before splitting commits.");
    const indexPath = path.resolve(cwd, yield* output(["rev-parse", "--git-path", "index"]));
    const originalIndex = yield* fs.readFile(indexPath);
    const worktree = yield* readWorkingTree();
    let base = head;
    let patch: string;
    if (request.scope.type === "branch") {
      if (!branch || worktree !== "")
        return yield* fail("Rebuilding branch history requires a clean feature branch.");
      const baseRef = request.scope.baseRef ?? (yield* git.resolveBaseRef(cwd, branch));
      if (!baseRef)
        return yield* fail("Could not resolve the branch base. Select an explicit base branch.");
      const baseCommit = yield* output([
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${baseRef}^{commit}`,
      ]);
      base = yield* output(["merge-base", head, baseCommit]);
      const diff = yield* execute([
        "diff",
        "--binary",
        "--full-index",
        "--no-ext-diff",
        "--no-textconv",
        base,
        head,
      ]);
      if (diff.stdoutTruncated)
        return yield* fail(`Logical commit snapshots support patches up to ${PATCH_LIMIT} bytes.`);
      patch = diff.stdout;
    } else {
      patch = worktree;
    }
    const units = parseLogicalChangeUnits(patch);
    if (units.length === 0) return { commitSha: head, subjects: [] as string[], backupRef: null };
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-logical-commits-" });
    const privateIndex = path.join(directory, "candidate-index");
    const candidateEnv = { GIT_INDEX_FILE: privateIndex, GIT_LITERAL_PATHSPECS: "1" };
    yield* execute(["read-tree", base], { env: candidateEnv });
    yield* execute(["apply", "--cached", "--recount", "--whitespace=nowarn", "-"], {
      env: candidateEnv,
      stdin: patch,
    });
    const targetTree = yield* output(["write-tree"], { env: candidateEnv });
    const writerDirectory = path.join(directory, "writer");
    yield* fs.makeDirectory(writerDirectory);
    const generated = yield* generatePlan({
      cwd: writerDirectory,
      branch,
      changeUnitSummary: summarizeLogicalChangeUnits(units),
      annotatedPatch: formatLogicalChangeUnitsForModel(units),
    });
    const seen = new Set<string>();
    const ids = new Set(units.map((unit) => unit.id));
    for (const commit of generated.commits) {
      if (!commit.subject.trim() || commit.hunkIds.length === 0)
        return yield* fail("The generated commit plan contained an empty commit.");
      for (const id of commit.hunkIds) {
        if (!ids.has(id) || seen.has(id))
          return yield* fail(
            `The generated commit plan contained an invalid or duplicate hunk ID: ${id}`,
          );
        seen.add(id);
      }
    }
    if (seen.size !== units.length)
      return yield* fail(
        `The generated commit plan omitted ${units.length - seen.size} change unit(s).`,
      );
    const backupRef = `${backupRoot}/original`;
    yield* execute(["update-ref", backupRef, head, ""]);
    const finalIndex = path.join(directory, "final-index");
    yield* fs.writeFile(finalIndex, originalIndex);
    const finalEnv = { GIT_INDEX_FILE: finalIndex, GIT_LITERAL_PATHSPECS: "1" };
    yield* execute(["-c", "core.splitIndex=false", "update-index", "--no-split-index"], {
      env: finalEnv,
    });
    const indexTree = yield* output(["write-tree"], { env: finalEnv });
    yield* execute(["update-ref", `${backupRoot}/index`, indexTree, ""]);
    const paths = (yield* execute(["diff", "--name-only", "--no-renames", "-z", head, targetTree]))
      .stdout;
    const currentIndex = yield* fs.readFile(indexPath);
    if (
      (yield* output(["rev-parse", "HEAD"])) !== head ||
      (yield* readBranch()) !== branchRef ||
      currentIndex.length !== originalIndex.length ||
      !currentIndex.every((byte, index) => byte === originalIndex[index]) ||
      (yield* readWorkingTree()) !== worktree
    )
      return yield* fail(
        `The checkout changed while planning commits; no commits were installed. Recovery refs: ${backupRoot}`,
      );

    const update = (from: string, to: string) =>
      execute(["update-ref", ...(branchRef ? [] : ["--no-deref"]), branchRef || "HEAD", to, from]);
    const installIndex = Effect.fn("LogicalCommitWorkflow.installIndex")(function* (
      bytes: Uint8Array,
    ) {
      const lockPath = `${indexPath}.lock`;
      let owned = false;
      yield* Effect.acquireRelease(
        Effect.uninterruptible(
          fs.writeFile(lockPath, bytes, { flag: "wx" }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                owned = true;
              }),
            ),
          ),
        ),
        () => (owned ? fs.remove(lockPath, { force: true }).pipe(Effect.ignore) : Effect.void),
      );
      yield* Effect.uninterruptible(
        fs.rename(lockPath, indexPath).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              owned = false;
            }),
          ),
        ),
      );
    }, Effect.scoped);
    let tip = head;
    return yield* Effect.gen(function* () {
      if (base !== head) {
        yield* update(head, base);
        tip = base;
      }
      for (const commit of generated.commits) {
        if ((yield* output(["rev-parse", "HEAD"])) !== tip || (yield* readBranch()) !== branchRef)
          return yield* fail(
            "The branch changed while committing. Stop other Git operations and retry.",
          );
        yield* execute(["read-tree", tip]);
        const selected = units.filter((unit) => commit.hunkIds.includes(unit.id));
        yield* execute(["apply", "--cached", "--recount", "--whitespace=nowarn", "-"], {
          stdin: buildPatchForLogicalChangeUnits(selected),
        });
        const created = yield* git.commit(cwd, commit.subject, commit.body);
        tip = created.commitSha;
        yield* execute(["update-ref", `${backupRoot}/candidate`, tip]);
      }
      if ((yield* output(["rev-parse", `${tip}^{tree}`])) !== targetTree)
        return yield* fail("The committed tree does not match the selected changes.");
      if (paths)
        yield* execute(
          [
            "restore",
            "--staged",
            `--source=${tip}`,
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
          ],
          { env: finalEnv, stdin: paths },
        );
      yield* installIndex(yield* fs.readFile(finalIndex));
      return {
        commitSha: tip,
        subjects: generated.commits.map((commit) => commit.subject),
        backupRef,
      };
    }).pipe(
      Effect.onError(() =>
        Effect.gen(function* () {
          if ((yield* readBranch()) !== branchRef) return;
          yield* update(tip, head);
          yield* installIndex(originalIndex);
        }).pipe(Effect.ignore),
      ),
    );
  },
  Effect.scoped,
  (effect, request, backupRoot) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new GitManagerError({
            operation: "splitCommits",
            cwd: request.cwd,
            detail: `${cause.message} Recovery refs, if created: ${backupRoot}`,
            cause,
          }),
      ),
    ),
);
