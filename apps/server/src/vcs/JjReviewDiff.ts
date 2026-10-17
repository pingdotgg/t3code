import type * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { unquoteGitPatchPath } from "@t3tools/shared/gitPatchPath";
import {
  type ReviewDiffFileStat,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewSource,
  type VcsError,
  type VcsStatusLocalResult,
  VcsProcessExitError,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import { resolveWorkspaceRefName } from "../jj/JjStatus.ts";
import { parseReviewNumstat, PATCH_RENDER_PREFIX_ARGS } from "./GitVcsDriverCore.ts";
import { EMPTY_TREE_OID, JJ_CONFLICT_PATHSPECS } from "./JjCheckpoints.ts";
import { colocatedGitCommand, jjCommand } from "./JjProcess.ts";
import type { JjChange, JjSegmentRow, JjVcsDriverShape } from "./JjVcsDriver.ts";
import {
  literalFilesetPath,
  localBookmarkRevset,
  refNameToRevset,
  remoteBookmarkRevset,
  splitRemoteRefName,
} from "./JjRevset.ts";
import type * as VcsDriver from "./VcsDriver.ts";
import type * as VcsProcess from "./VcsProcess.ts";

export interface JjReviewDiffDeps {
  readonly process: VcsProcess.VcsProcess["Service"];
  readonly crypto: Crypto.Crypto;
  /** Fails unless jj can operate here; yields the colocated git store. */
  readonly ensureGitDir: (operation: string, cwd: string) => Effect.Effect<string, VcsError>;
  readonly currentChange: (cwd: string) => Effect.Effect<JjChange, VcsError>;
  readonly currentSegment: (cwd: string) => Effect.Effect<ReadonlyArray<JjSegmentRow>, VcsError>;
  readonly repoPaths: JjVcsDriverShape["repoPaths"];
  readonly listWorkspaces: JjVcsDriverShape["listWorkspaces"];
  readonly listBookmarks: JjVcsDriverShape["listBookmarks"];
  readonly countRevset: JjVcsDriverShape["countRevset"];
  readonly changeAt: (cwd: string, revset: string) => Effect.Effect<JjChange | null, VcsError>;
  readonly listRemoteNames: (cwd: string) => Effect.Effect<ReadonlyArray<string>, VcsError>;
  readonly resolveDefaultBookmark: (cwd: string) => Effect.Effect<string | null, VcsError>;
}

export type JjReviewDiffOps = Pick<
  Required<VcsDriver.VcsDriver["Service"]>,
  "getDiffPreview" | "getDiffFileContents"
> & {
  readonly readBranchChangeTotals: (input: {
    readonly cwd: string;
    readonly change: JjChange;
    readonly refName?: string | null;
  }) => Effect.Effect<VcsStatusLocalResult["branchChanges"], VcsError>;
};

const REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES = 120_000;
const REVIEW_DIFF_FILE_MAX_OUTPUT_BYTES = 1024 * 1024;
const REVIEW_METADATA_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const TRUNK_REVSET = "trunk()";

function fullContextContents(patch: string): { oldContents: string; newContents: string } | null {
  let inHunk = false;
  let hasHunk = false;
  let previousPrefix = "";
  let oldContents = "";
  let newContents = "";
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@ ")) {
      inHunk = true;
      hasHunk = true;
      continue;
    }
    if (!inHunk) continue;
    const prefix = line[0];
    if (line === "\\ No newline at end of file") {
      if (previousPrefix !== "+") oldContents = oldContents.slice(0, -1);
      if (previousPrefix !== "-") newContents = newContents.slice(0, -1);
    } else if (prefix === " " || prefix === "-" || prefix === "+") {
      if (prefix !== "+") oldContents += `${line.slice(1)}\n`;
      if (prefix !== "-") newContents += `${line.slice(1)}\n`;
      previousPrefix = prefix;
    }
  }
  return hasHunk ? { oldContents, newContents } : null;
}

export const makeJjReviewDiff = (deps: JjReviewDiffDeps): JjReviewDiffOps => {
  const hashDiff = (diff: string, files: ReadonlyArray<ReviewDiffFileStat>) =>
    deps.crypto
      .digest("SHA-256", new TextEncoder().encode(JSON.stringify([diff, files])))
      .pipe(Effect.map(Hex.encode), Effect.orDie);

  const runDiff = Effect.fn("JjVcsDriver.getDiffPreview.diff")(function* (
    operation: string,
    gitDir: string,
    cwd: string,
    range: ReadonlyArray<string>,
    ignoreWhitespace: boolean | undefined,
    file: ReviewDiffPreviewInput["file"],
  ) {
    const args = [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--minimal",
      ...PATCH_RENDER_PREFIX_ARGS,
      "--find-renames",
      ...(ignoreWhitespace === true ? ["--ignore-all-space"] : []),
    ];
    const paths = [
      ...JJ_CONFLICT_PATHSPECS.filter((path) => !file || path !== "."),
      ...(file
        ? [file.path, ...(file.previousPath ? [file.previousPath] : [])].map(
            (path) => `:(top,literal)${path}`,
          )
        : []),
    ];
    const stats = yield* colocatedGitCommand(
      deps.process,
      operation,
      { gitDir, cwd },
      [...args, "--numstat", "-z", ...range, ...paths],
      { maxOutputBytes: REVIEW_METADATA_MAX_OUTPUT_BYTES },
    );
    const files = parseReviewNumstat(stats.stdout);
    if (files.length === 0) return { stdout: "", stdoutTruncated: false, files };
    const patch = yield* colocatedGitCommand(
      deps.process,
      operation,
      { gitDir, cwd },
      [...args, "--patch", ...range, ...paths],
      {
        maxOutputBytes: file
          ? REVIEW_DIFF_FILE_MAX_OUTPUT_BYTES
          : REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES,
        outputMode: "truncate",
        appendTruncationMarker: true,
      },
    );
    return { ...patch, files };
  });

  const runMergedParentDiff = Effect.fn("JjVcsDriver.getDiffPreview.mergedParents")(function* (
    operation: string,
    gitDir: string,
    cwd: string,
    commitId: string,
    ignoreWhitespace: boolean | undefined,
    file: ReviewDiffPreviewInput["file"],
  ) {
    const args = [
      "diff",
      "-r",
      commitId,
      "--git",
      ...(ignoreWhitespace ? ["--ignore-all-space"] : []),
    ];
    const paths = file
      ? [
          "--",
          `root-${literalFilesetPath(file.path)}`,
          ...(file.previousPath ? [`root-${literalFilesetPath(file.previousPath)}`] : []),
        ]
      : [];
    // Native jj diffs use the merged parents' tree rather than an arbitrary first parent.
    const metadata = yield* jjCommand(
      deps.process,
      operation,
      cwd,
      [...args, "--context=0", ...paths],
      {
        ignoreWorkingCopy: true,
        maxOutputBytes: REVIEW_METADATA_MAX_OUTPUT_BYTES,
        outputMode: "error",
      },
    );
    const stats =
      metadata.stdout === ""
        ? ""
        : (yield* colocatedGitCommand(
            deps.process,
            operation,
            { gitDir, cwd },
            ["apply", "--numstat", "-z"],
            { stdin: metadata.stdout, maxOutputBytes: REVIEW_METADATA_MAX_OUTPUT_BYTES },
          )).stdout;
    const previousPaths = new Map<string, string>();
    let previousPath: string | null = null;
    for (const line of metadata.stdout.split("\n")) {
      if (line.startsWith("diff --git ")) previousPath = null;
      else if (line.startsWith("rename from ")) previousPath = unquoteGitPatchPath(line.slice(12));
      else if (line.startsWith("rename to ") && previousPath !== null) {
        previousPaths.set(unquoteGitPatchPath(line.slice(10)), previousPath);
      }
    }
    const files = parseReviewNumstat(stats).map((stat) => ({
      ...stat,
      previousPath: previousPaths.get(stat.path) ?? stat.previousPath,
    }));
    if (files.length === 0) return { stdout: "", stdoutTruncated: false, files };
    const patch = yield* jjCommand(deps.process, operation, cwd, [...args, ...paths], {
      ignoreWorkingCopy: true,
      maxOutputBytes: file ? REVIEW_DIFF_FILE_MAX_OUTPUT_BYTES : REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES,
      outputMode: "truncate",
      appendTruncationMarker: true,
    });
    return { ...patch, files };
  });

  const resolveBaseChange = Effect.fn("JjVcsDriver.getDiffPreview.resolveBase")(function* (
    cwd: string,
    gitDir: string,
    baseRef?: string,
    snapshotRefName?: string | null,
  ): Effect.fn.Return<{ readonly label: string; readonly change: JjChange | null }, VcsError> {
    const remotes = yield* deps.listRemoteNames(cwd);
    const primaryRemote = remotes.includes("origin") ? "origin" : remotes[0];
    const resolve = Effect.fn(function* (label: string) {
      const normalized = label.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, "");
      const revset =
        normalized === TRUNK_REVSET ? normalized : refNameToRevset(normalized, remotes);
      const localRevset = localBookmarkRevset(normalized);
      const checkLocal =
        normalized !== TRUNK_REVSET &&
        !label.startsWith("refs/remotes/") &&
        (label.startsWith("refs/heads/") || splitRemoteRefName(normalized, remotes) === null);
      if (checkLocal) {
        const local = yield* deps.changeAt(cwd, localRevset);
        if (local !== null || label.startsWith("refs/heads/")) return local;
      }
      const change =
        checkLocal && revset === localRevset ? null : yield* deps.changeAt(cwd, revset);
      if (
        change === null &&
        !label.startsWith("refs/") &&
        splitRemoteRefName(normalized, remotes) !== null
      ) {
        return yield* deps.changeAt(cwd, localRevset);
      }
      if (
        change !== null ||
        label.startsWith("refs/") ||
        splitRemoteRefName(normalized, remotes) !== null ||
        normalized === TRUNK_REVSET
      ) {
        return change;
      }
      return primaryRemote === undefined
        ? null
        : yield* deps.changeAt(cwd, `present(${remoteBookmarkRevset(primaryRemote, normalized)})`);
    });
    if (baseRef !== undefined) return { label: baseRef, change: yield* resolve(baseRef) };
    const resolveAutomatic = Effect.fn(function* (label: string) {
      const normalized = label.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, "");
      if (
        primaryRemote !== undefined &&
        !label.startsWith("refs/heads/") &&
        normalized !== TRUNK_REVSET &&
        splitRemoteRefName(normalized, remotes) === null
      ) {
        const remote = yield* deps.changeAt(
          cwd,
          `present(${remoteBookmarkRevset(primaryRemote, normalized)})`,
        );
        if (remote !== null) return { label: `${primaryRemote}/${normalized}`, change: remote };
      }
      return { label: normalized, change: yield* resolve(label) };
    });
    const bookmark =
      snapshotRefName === undefined
        ? yield* resolveWorkspaceRefName(deps, cwd, yield* deps.currentSegment(cwd))
        : snapshotRefName;
    if (bookmark !== null) {
      const configured = yield* colocatedGitCommand(
        deps.process,
        "JjVcsDriver.getDiffPreview.resolveBase",
        { gitDir, cwd },
        [
          "config",
          "--get-regexp",
          `^branch\\.${bookmark.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(t3-merge-base-ref|gh-merge-base)$`,
        ],
        { allowNonZeroExit: true },
      );
      let fullRef = "";
      let legacyBase = "";
      if (configured.exitCode === 0) {
        for (const line of configured.stdout.split("\n")) {
          const separator = line.indexOf(" ");
          const key = line.slice(0, separator);
          const value = line.slice(separator + 1).trim();
          if (key === `branch.${bookmark}.t3-merge-base-ref`) fullRef = value;
          else if (key === `branch.${bookmark}.gh-merge-base`) legacyBase = value;
        }
      }
      if (fullRef.startsWith("refs/heads/") || fullRef.startsWith("refs/remotes/")) {
        const change = yield* resolve(fullRef);
        if (change !== null) {
          return { label: fullRef.replace(/^refs\/(?:heads|remotes)\//, ""), change };
        }
      }
      if (legacyBase !== "") {
        const base = yield* resolveAutomatic(legacyBase);
        if (base.change !== null) return base;
      }
    }
    const label = (yield* deps.resolveDefaultBookmark(cwd)) ?? TRUNK_REVSET;
    return yield* resolveAutomatic(label);
  });

  const readBranchChangeTotals: JjReviewDiffOps["readBranchChangeTotals"] = Effect.fn(
    "JjVcsDriver.readBranchChangeTotals",
  )(function* (input) {
    const operation = "JjVcsDriver.readBranchChangeTotals";
    const gitDir = yield* deps.ensureGitDir(operation, input.cwd);
    const base = yield* resolveBaseChange(input.cwd, gitDir, undefined, input.refName);
    const baseChange = base.change;
    const baseRef = baseChange === null ? null : base.label;
    if (baseChange === null) {
      return {
        baseRef: null,
        insertions: input.change.fileStats.reduce((total, file) => total + file.linesAdded, 0),
        deletions: input.change.fileStats.reduce((total, file) => total + file.linesRemoved, 0),
      };
    }
    // Polling reuses the already snapshotted tree and reads only metadata, never rendered patches.
    const stats = yield* colocatedGitCommand(
      deps.process,
      operation,
      { gitDir, cwd: input.cwd },
      [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--minimal",
        "--find-renames",
        "--numstat",
        "-z",
        `${baseChange.commitId}...${input.change.commitId}`,
        ...JJ_CONFLICT_PATHSPECS,
      ],
      { maxOutputBytes: REVIEW_METADATA_MAX_OUTPUT_BYTES },
    ).pipe(
      Effect.catch((error) => {
        if (error._tag !== "VcsProcessExitError" || error.exitCode !== 128) {
          return Effect.fail(error);
        }
        // Only diagnose a failed triple-dot diff. Unrelated histories have no optional totals;
        // malformed commands, missing objects, timeouts and all other failures remain failures.
        return colocatedGitCommand(
          deps.process,
          operation,
          { gitDir, cwd: input.cwd },
          ["merge-base", baseChange.commitId, input.change.commitId],
          { allowNonZeroExit: true },
        ).pipe(
          Effect.catch(() => Effect.fail(error)),
          Effect.flatMap((diagnostic) =>
            diagnostic.exitCode === 1 && diagnostic.stdout === "" && diagnostic.stderr === ""
              ? Effect.succeed(undefined)
              : Effect.fail(error),
          ),
        );
      }),
    );
    if (stats === undefined) return undefined;
    const files = parseReviewNumstat(stats.stdout);
    return {
      baseRef,
      insertions: files.reduce((total, file) => total + file.additions, 0),
      deletions: files.reduce((total, file) => total + file.deletions, 0),
    };
  });

  const getDiffPreview: JjReviewDiffOps["getDiffPreview"] = Effect.fn("JjVcsDriver.getDiffPreview")(
    function* (input) {
      const operation = "JjVcsDriver.getDiffPreview";
      const gitDir = yield* deps.ensureGitDir(operation, input.cwd);

      // jj auto-snapshots, so untracked non-ignored files are already inside `@`: no index dance.
      const change = yield* deps.currentChange(input.cwd);
      const workingTreeBase = change.parentCommitIds[0] ?? EMPTY_TREE_OID;
      const empty = { stdout: "", stdoutTruncated: false, files: [] };
      const workingTreeResult =
        input.file?.sourceKind === "branch-range"
          ? empty
          : change.parentCommitIds.length > 1
            ? yield* runMergedParentDiff(
                operation,
                gitDir,
                input.cwd,
                change.commitId,
                input.ignoreWhitespace,
                input.file,
              )
            : yield* runDiff(
                operation,
                gitDir,
                input.cwd,
                [workingTreeBase, change.commitId],
                input.ignoreWhitespace,
                input.file,
              );

      const base = yield* resolveBaseChange(input.cwd, gitDir, input.baseRef);
      const baseResult =
        base.change === null || input.file?.sourceKind === "working-tree"
          ? empty
          : yield* runDiff(
              operation,
              gitDir,
              input.cwd,
              [`${base.change.commitId}...${change.commitId}`],
              input.ignoreWhitespace,
              input.file,
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
          files: workingTreeResult.files,
          diffHash: yield* hashDiff(workingTreeResult.stdout, workingTreeResult.files),
          truncated: workingTreeResult.stdoutTruncated,
        },
        {
          id: "branch-range",
          kind: "branch-range",
          title: base.change === null ? "Against base branch" : `Against ${base.label}`,
          baseRef: base.change?.commitId ?? null,
          headRef: "@",
          diff: baseResult.stdout,
          files: baseResult.files,
          diffHash: yield* hashDiff(baseResult.stdout, baseResult.files),
          truncated: baseResult.stdoutTruncated,
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
        new VcsUnsupportedOperationError({
          operation,
          kind: "jj",
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
    if (input.sourceKind === "working-tree" && baseRef === "@-" && headRef === "@") {
      const change = yield* workingCopy;
      if (change.parentCommitIds.length > 1) {
        const patch = yield* jjCommand(
          deps.process,
          operation,
          input.cwd,
          [
            "diff",
            "-r",
            change.commitId,
            "--git",
            "--context=1048576",
            "--",
            `root-${literalFilesetPath(input.oldPath)}`,
            ...(input.newPath === input.oldPath
              ? []
              : [`root-${literalFilesetPath(input.newPath)}`]),
          ],
          {
            ignoreWorkingCopy: true,
            maxOutputBytes: 2 * REVIEW_DIFF_FILE_MAX_OUTPUT_BYTES,
            outputMode: "error",
          },
        );
        if (/^Binary files /m.test(patch.stdout)) {
          return yield* Effect.fail(
            new VcsUnsupportedOperationError({
              operation,
              kind: "jj",
              detail: `Cannot expand binary file '${input.newPath}'.`,
            }),
          );
        }
        const contents = fullContextContents(patch.stdout);
        if (contents !== null) return contents;
        if (/^(?:deleted|new) file mode /m.test(patch.stdout)) {
          return { oldContents: "", newContents: "" };
        }
        const contentsAtHead = yield* readFileAtRevision(
          operation,
          gitDir,
          input.cwd,
          change.commitId,
          input.newPath,
        );
        return { oldContents: contentsAtHead, newContents: contentsAtHead };
      }
    }
    const [baseOid, headOid] = yield* Effect.all([
      input.sourceKind === "branch-range"
        ? resolveBaseChange(input.cwd, gitDir, baseRef).pipe(
            Effect.map((base) => base.change?.commitId ?? null),
          )
        : resolveFileRevision(input.cwd, baseRef, workingCopy),
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
    let comparisonBase = baseOid;
    if (input.sourceKind === "branch-range") {
      const mergeBase = yield* colocatedGitCommand(
        deps.process,
        operation,
        { gitDir, cwd: input.cwd },
        ["merge-base", baseOid, headOid],
      );
      comparisonBase = mergeBase.stdout.trim();
    }

    const [oldContents, newContents] = yield* Effect.all(
      [
        input.changeType === "new"
          ? Effect.succeed("")
          : readFileAtRevision(operation, gitDir, input.cwd, comparisonBase, input.oldPath),
        input.changeType === "deleted"
          ? Effect.succeed("")
          : readFileAtRevision(operation, gitDir, input.cwd, headOid, input.newPath),
      ],
      { concurrency: 2 },
    );

    return { oldContents, newContents };
  });

  return { getDiffPreview, getDiffFileContents, readBranchChangeTotals };
};
