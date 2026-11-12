import { reportSteps, type ProgressReporter } from "./WorkflowProgress.ts";
import { GitManagerError, type GitStartCommitWorkflowInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type {
  CommitPlanGenerationResult,
  ProviderTextGeneration,
} from "@t3tools/provider-core/server/textGeneration";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  buildPatchForLogicalChangeUnits,
  formatLogicalChangeUnitsForModel,
  parseLogicalChangeUnits,
  summarizeLogicalChangeUnits,
} from "./LogicalCommitPatch.ts";

const PATCH_LIMIT = 2_000_000;
const isGitManagerError = Schema.is(GitManagerError);

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
    onProgress?: ProgressReporter,
  ) {
    const git = yield* GitVcsDriver.GitVcsDriver;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = request.cwd;
    const progress = reportSteps(
      onProgress,
      ["prepare", "plan", "create", "verify", "install"].map((id) => ({
        id,
        group: "Logical commits",
        label:
          {
            prepare: "Read changes",
            plan: "Plan commits",
            create: "Create commits",
            verify: "Verify result",
            install: "Restore index",
          }[id] ?? id,
        state: "pending",
      })),
    );
    const stage = (id: string, label: string) =>
      progress(label, (steps) =>
        steps.map((item) =>
          item.id === id
            ? { ...item, state: "running" }
            : item.state === "running"
              ? { ...item, state: "completed" }
              : item,
        ),
      );
    yield* stage("prepare", "Reading changes...");

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
        "filePaths" in request.scope ? request.scope.filePaths : undefined,
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
    let rangeHead = head;
    const followingCommits: string[] = [];
    let patch: string;
    if (request.scope.type === "branch" || request.scope.type === "branch_range") {
      if (!branch || worktree !== "")
        return yield* fail("Rebuilding branch history requires a clean feature branch.");
      if (request.scope.expectedHeadSha && request.scope.expectedHeadSha !== head)
        return yield* fail(
          "The branch changed after the commit list was loaded. Reopen the dialog and retry.",
        );
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
      if (request.scope.startCommit || request.scope.endCommit) {
        const listed = yield* execute([
          "rev-list",
          "--first-parent",
          "--reverse",
          `${base}..${head}`,
        ]);
        if (listed.stdoutTruncated)
          return yield* fail("The branch history is too large to select a commit range.");
        const commits = listed.stdout.trim().split("\n").filter(Boolean);
        const startIndex = request.scope.startCommit
          ? commits.indexOf(request.scope.startCommit)
          : 0;
        const endIndex = request.scope.endCommit
          ? commits.indexOf(request.scope.endCommit)
          : commits.length - 1;
        if (startIndex < 0 || endIndex < startIndex)
          return yield* fail("Select an ordered commit range from this branch after its base.");
        if (request.scope.startCommit) {
          const parent = yield* output([
            "rev-parse",
            "--verify",
            "--end-of-options",
            `${request.scope.startCommit}^1`,
          ]);
          if (
            (yield* execute(["merge-base", "--is-ancestor", base, parent], {
              allowNonZeroExit: true,
            })).exitCode !== 0
          )
            return yield* fail("The first selected commit must follow the branch base.");
          base = parent;
        }
        rangeHead = commits[endIndex]!;
        for (const sha of commits.slice(endIndex + 1)) {
          const raw = yield* execute(["cat-file", "commit", sha]);
          if (raw.stdoutTruncated)
            return yield* fail("A following commit message exceeds the supported size.");
          const headers = raw.stdout.split("\n\n", 1)[0] ?? "";
          if (
            (headers.match(/^parent /gm)?.length ?? 0) !== 1 ||
            /^gpgsig(?:-sha256)? |^mergetag /m.test(headers)
          )
            return yield* fail(
              "The commits after the selected range contain a merge or signed commit. Extend the range through those commits.",
            );
          followingCommits.push(raw.stdout);
        }
      }
      const diff = yield* execute([
        "diff",
        "--binary",
        "--full-index",
        "--no-ext-diff",
        "--no-textconv",
        base,
        rangeHead,
      ]);
      if (diff.stdoutTruncated)
        return yield* fail(`Logical commit snapshots support patches up to ${PATCH_LIMIT} bytes.`);
      patch = diff.stdout;
    } else {
      patch = worktree;
    }
    const units = parseLogicalChangeUnits(patch);
    if (units.length === 0) {
      yield* progress("No changes to commit", (steps) =>
        steps.map((item) => ({ ...item, state: item.id === "prepare" ? "completed" : "skipped" })),
      );
      return { commitSha: head, subjects: [] as string[], backupRef: null };
    }
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
    const planInput = {
      cwd: writerDirectory,
      branch,
      changeUnitSummary: summarizeLogicalChangeUnits(units),
      annotatedPatch: formatLogicalChangeUnitsForModel(units),
    };
    const validationError = (plan: CommitPlanGenerationResult) => {
      const seen = new Set<string>();
      const ids = new Set(units.map((unit) => unit.id));
      for (const commit of plan.commits) {
        if (!commit.subject.trim() || commit.hunkIds.length === 0)
          return "The generated commit plan contained an empty commit.";
        for (const id of commit.hunkIds) {
          if (!ids.has(id) || seen.has(id))
            return `The generated commit plan contained an invalid or duplicate hunk ID: ${id}`;
          seen.add(id);
        }
      }
      const missing = units.filter((unit) => !seen.has(unit.id));
      return missing.length > 0
        ? `The generated commit plan omitted ${missing.length} change unit(s): ${missing.map((unit) => `${unit.id} (${unit.filePath})`).join(", ")}.`
        : null;
    };
    yield* stage("plan", "Planning logical commits...");
    let generated = yield* generatePlan(planInput);
    const problem = validationError(generated);
    if (problem) {
      yield* stage("plan", "Correcting the commit plan...");
      generated = yield* generatePlan({
        ...planInput,
        correction: { error: problem, previousPlan: generated },
      });
      const remainingProblem = validationError(generated);
      if (remainingProblem) return yield* fail(remainingProblem);
    }
    yield* progress(`Creating ${generated.commits.length} logical commits...`, (steps) => [
      ...steps,
      ...generated.commits.map((commit, index) => ({
        id: `commit:${index}`,
        group: "Commits",
        label: `${index + 1}. ${commit.subject.slice(0, 160)}`,
        state: "pending" as const,
      })),
    ]);
    yield* stage("create", `Creating ${generated.commits.length} logical commits...`);
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
      for (const [index, commit] of generated.commits.entries()) {
        yield* progress(
          `Creating commit ${index + 1}/${generated.commits.length}: ${commit.subject.slice(0, 160)}`,
          (steps) =>
            steps.map((step) =>
              step.id === `commit:${index}` ? { ...step, state: "running" } : step,
            ),
        );
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
        yield* progress(
          `Created commit ${index + 1}/${generated.commits.length}: ${commit.subject.slice(0, 160)}`,
          (steps) =>
            steps.map((step) =>
              step.id === `commit:${index}` ? { ...step, state: "completed" } : step,
            ),
        );
      }
      yield* stage("verify", "Verifying committed changes...");
      if ((yield* output(["rev-parse", `${tip}^{tree}`])) !== targetTree)
        return yield* fail("The committed tree does not match the selected changes.");
      for (const raw of followingCommits) {
        const next = yield* output(["hash-object", "-t", "commit", "-w", "--stdin"], {
          stdin: raw.replace(/^parent [0-9a-f]+$/m, `parent ${tip}`),
        });
        yield* update(tip, next);
        tip = next;
        yield* execute(["update-ref", `${backupRoot}/candidate`, tip]);
      }
      if (
        (request.scope.type === "branch" || request.scope.type === "branch_range") &&
        (yield* output(["rev-parse", `${tip}^{tree}`])) !==
          (yield* output(["rev-parse", `${head}^{tree}`]))
      )
        return yield* fail("The rebuilt branch tree does not match the original branch.");
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
      yield* stage("install", "Restoring the index...");
      yield* installIndex(yield* fs.readFile(finalIndex));
      yield* progress("Logical commits created", (steps) =>
        steps.map((item) => ({ ...item, state: "completed" })),
      );
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
          yield* progress("Commits rolled back", (steps) =>
            steps.map((step) =>
              step.id.startsWith("commit:") && step.state === "completed"
                ? { ...step, state: "skipped" }
                : step,
            ),
          );
        }).pipe(Effect.ignore),
      ),
    );
  },
  Effect.scoped,
  (effect, request, backupRoot, _generatePlan, _onProgress?: ProgressReporter) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new GitManagerError({
            operation: "splitCommits",
            cwd: request.cwd,
            detail: `${isGitManagerError(cause) ? cause.detail : cause.message} Recovery refs, if created: ${backupRoot}`,
            cause,
          }),
      ),
    ),
);
