import * as NodeCrypto from "node:crypto";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  type ReviewDiffPreviewSource,
  type VcsError,
  VcsProcessExitError,
} from "@t3tools/contracts";
import { PATCH_RENDER_PREFIX_ARGS } from "./GitVcsDriverCore.ts";
import { EMPTY_TREE_OID, JJ_CONFLICT_PATHSPECS } from "./JjCheckpoints.ts";
import { colocatedGitCommand } from "./JjProcess.ts";
import type { JjChange } from "./JjVcsDriver.ts";
import { refNameToRevset } from "./JjRevset.ts";
import type * as VcsDriver from "./VcsDriver.ts";
import type * as VcsProcess from "./VcsProcess.ts";

export interface JjReviewDiffDeps {
  readonly process: VcsProcess.VcsProcess["Service"];
  /** Fails unless jj can operate here; yields the colocated git store. */
  readonly ensureGitDir: (operation: string, cwd: string) => Effect.Effect<string, VcsError>;
  readonly currentChange: (cwd: string) => Effect.Effect<JjChange, VcsError>;
  readonly changeAt: (cwd: string, revset: string) => Effect.Effect<JjChange | null, VcsError>;
  readonly listRemoteNames: (cwd: string) => Effect.Effect<ReadonlyArray<string>, VcsError>;
  readonly resolveDefaultBookmark: (cwd: string) => Effect.Effect<string | null, VcsError>;
}

export type JjReviewDiffOps = Pick<
  Required<VcsDriver.VcsDriver["Service"]>,
  "getDiffPreview" | "getDiffFileContents"
>;

const REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES = 120_000;
const REVIEW_DIFF_FILE_MAX_OUTPUT_BYTES = 1024 * 1024;
const TRUNK_REVSET = "trunk()";

function hashDiff(diff: string): string {
  return NodeCrypto.createHash("sha256").update(diff, "utf8").digest("hex");
}

export const makeJjReviewDiff = (deps: JjReviewDiffDeps): JjReviewDiffOps => {
  const runDiff = (
    operation: string,
    gitDir: string,
    cwd: string,
    range: ReadonlyArray<string>,
    ignoreWhitespace: boolean | undefined,
  ) =>
    colocatedGitCommand(
      deps.process,
      operation,
      { gitDir, cwd },
      [
        "diff",
        "--patch",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--minimal",
        ...PATCH_RENDER_PREFIX_ARGS,
        "--find-renames",
        ...(ignoreWhitespace === true ? ["--ignore-all-space"] : []),
        ...range,
        ...JJ_CONFLICT_PATHSPECS,
      ],
      {
        maxOutputBytes: REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES,
        outputMode: "truncate",
        appendTruncationMarker: true,
      },
    );

  const resolveBaseChange = Effect.fn("JjVcsDriver.getDiffPreview.resolveBase")(function* (
    cwd: string,
    baseRef: string | undefined,
  ): Effect.fn.Return<{ readonly label: string; readonly change: JjChange | null }, VcsError> {
    const label = baseRef ?? (yield* deps.resolveDefaultBookmark(cwd)) ?? TRUNK_REVSET;
    const revset =
      label === TRUNK_REVSET
        ? TRUNK_REVSET
        : refNameToRevset(label, yield* deps.listRemoteNames(cwd));
    return { label, change: yield* deps.changeAt(cwd, revset) };
  });

  const getDiffPreview: JjReviewDiffOps["getDiffPreview"] = Effect.fn("JjVcsDriver.getDiffPreview")(
    function* (input) {
      const operation = "JjVcsDriver.getDiffPreview";
      const gitDir = yield* deps.ensureGitDir(operation, input.cwd);

      // jj auto-snapshots, so untracked non-ignored files are already inside `@`: no index dance.
      const change = yield* deps.currentChange(input.cwd);
      const workingTreeBase = change.parentCommitIds[0] ?? EMPTY_TREE_OID;
      const workingTreeResult = yield* runDiff(
        operation,
        gitDir,
        input.cwd,
        [workingTreeBase, change.commitId],
        input.ignoreWhitespace,
      );

      const base = yield* resolveBaseChange(input.cwd, input.baseRef);
      const baseResult =
        base.change === null
          ? null
          : yield* runDiff(
              operation,
              gitDir,
              input.cwd,
              [`${base.change.commitId}...${change.commitId}`],
              input.ignoreWhitespace,
            );

      const sources: ReadonlyArray<ReviewDiffPreviewSource> = [
        {
          id: "working-tree",
          kind: "working-tree",
          // The git tree of a conflicted commit holds one arbitrary side of each conflicted file,
          // not the markers on disk, so the client must not present it as the file.
          title: change.conflict ? "Working copy (conflicted)" : "Working copy",
          baseRef: "@-",
          headRef: "@",
          diff: workingTreeResult.stdout,
          diffHash: hashDiff(workingTreeResult.stdout),
          truncated: workingTreeResult.stdoutTruncated,
        },
        {
          id: "branch-range",
          kind: "branch-range",
          title: base.change === null ? "Against base branch" : `Against ${base.label}`,
          baseRef: base.change?.commitId ?? null,
          headRef: "@",
          diff: baseResult?.stdout ?? "",
          diffHash: hashDiff(baseResult?.stdout ?? ""),
          truncated: baseResult?.stdoutTruncated ?? false,
        },
      ];

      return { cwd: input.cwd, generatedAt: yield* DateTime.now, sources };
    },
  );

  const resolveFileRevision = Effect.fn("JjVcsDriver.getDiffFileContents.resolveRevision")(
    function* (
      cwd: string,
      ref: string,
      workingCopy: Effect.Effect<JjChange, VcsError>,
    ): Effect.fn.Return<string | null, VcsError> {
      if (ref === "@") {
        return (yield* workingCopy).commitId;
      }
      if (ref === "@-") {
        return (yield* workingCopy).parentCommitIds[0] ?? EMPTY_TREE_OID;
      }
      const change = yield* deps.changeAt(
        cwd,
        refNameToRevset(ref, yield* deps.listRemoteNames(cwd)),
      );
      return change?.commitId ?? null;
    },
  );

  const readFileAtRevision = Effect.fn("JjVcsDriver.getDiffFileContents.show")(function* (
    operation: string,
    gitDir: string,
    cwd: string,
    revision: string,
    relativePath: string,
  ): Effect.fn.Return<string, VcsError> {
    if (revision === EMPTY_TREE_OID) {
      return "";
    }
    const result = yield* colocatedGitCommand(
      deps.process,
      operation,
      { gitDir, cwd },
      ["show", `${revision}:${relativePath}`],
      { maxOutputBytes: REVIEW_DIFF_FILE_MAX_OUTPUT_BYTES },
    );
    if (result.stdout.includes("\0")) {
      return yield* Effect.fail(
        new VcsProcessExitError({
          operation,
          command: "git show",
          cwd,
          exitCode: 0,
          detail: `Cannot expand binary file '${relativePath}'.`,
        }),
      );
    }
    return result.stdout;
  });

  const getDiffFileContents: JjReviewDiffOps["getDiffFileContents"] = Effect.fn(
    "JjVcsDriver.getDiffFileContents",
  )(function* (input) {
    const operation = "JjVcsDriver.getDiffFileContents";
    const gitDir = yield* deps.ensureGitDir(operation, input.cwd);

    const baseRef = input.baseRef ?? (input.sourceKind === "working-tree" ? "@-" : null);
    const headRef = input.headRef ?? (input.sourceKind === "working-tree" ? "@" : null);
    if (baseRef === null || headRef === null) {
      return yield* Effect.fail(
        new VcsProcessExitError({
          operation,
          command: "git show",
          cwd: input.cwd,
          exitCode: 1,
          detail: "Diff file expansion requires both base and head refs.",
        }),
      );
    }

    // `@` and `@-` both read the working copy, and every read snapshots it, so share one.
    const workingCopy = yield* Effect.cached(deps.currentChange(input.cwd));
    const [baseOid, headOid] = yield* Effect.all([
      resolveFileRevision(input.cwd, baseRef, workingCopy),
      resolveFileRevision(input.cwd, headRef, workingCopy),
    ]);
    if (baseOid === null || headOid === null) {
      return yield* Effect.fail(
        new VcsProcessExitError({
          operation,
          command: "git show",
          cwd: input.cwd,
          exitCode: 1,
          detail: "Diff file expansion could not resolve the comparison revisions.",
        }),
      );
    }

    const [oldContents, newContents] = yield* Effect.all(
      [
        input.changeType === "new"
          ? Effect.succeed("")
          : readFileAtRevision(operation, gitDir, input.cwd, baseOid, input.oldPath),
        input.changeType === "deleted"
          ? Effect.succeed("")
          : readFileAtRevision(operation, gitDir, input.cwd, headOid, input.newPath),
      ],
      { concurrency: 2 },
    );

    return { oldContents, newContents };
  });

  return { getDiffPreview, getDiffFileContents };
};
