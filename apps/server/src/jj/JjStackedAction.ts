import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import {
  GitCommandError,
  SourceControlProviderKind,
  type GitActionProgressEvent,
  type GitActionProgressPhase,
  type GitManagerServiceError,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
} from "@t3tools/contracts";
import { resolveAutoFeatureBranchName } from "@t3tools/shared/git";
import { getChangeRequestTerminologyForKind } from "@t3tools/shared/sourceControl";

import {
  isCommitAction,
  resolveCommitAndBranchSuggestion,
  resolveTextGenerationSettings,
  runChangeRequestStep,
  summarizeGitActionResult,
  type ChangeRequestStepServices,
  type ChangeRequestVcsReads,
  type CommitAndBranchSuggestion,
  type GitActionProgressPayload,
  type SourceControlTextGenerationSettings,
} from "../sourceControl/ChangeRequestStep.ts";
import type * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as JjProcess from "../vcs/JjProcess.ts";
import { literalFilesetPath, localBookmarkRevset } from "../vcs/JjRevset.ts";
import type { JjSegmentRow, JjVcsDriverShape } from "../vcs/JjVcsDriver.ts";
import type * as VcsProcess from "../vcs/VcsProcess.ts";
import { jjFailure, mapJjFailure } from "./JjFailure.ts";
import type { JjRemoteOps } from "./JjRemotes.ts";
import {
  computeAheadBehindCounts,
  readImportedUpstream,
  resolveWorkspaceRefName,
  resolveUpstreamContext,
  strandedSegmentRows,
} from "./JjStatus.ts";

const COMMIT_TIMEOUT_MS = 10 * 60_000;
const DIFF_SUMMARY_MAX_BYTES = 64 * 1024;
const DIFF_PATCH_MAX_BYTES = 1024 * 1024;

/**
 * The selected paths as jj sees them: after the argument terminator, so a client-supplied path can
 * never be read as a jj option, and each one a literal fileset rather than an expression.
 */
function filesetArguments(filePaths: readonly string[] | undefined): ReadonlyArray<string> {
  return filePaths === undefined || filePaths.length === 0
    ? []
    : ["--", ...filePaths.map(literalFilesetPath)];
}

export interface JjStackedActionDeps {
  readonly driver: JjVcsDriverShape;
  /** Git against the colocated store: what the shared step's template and history reads run on. */
  readonly executeGit: GitVcsDriver.GitVcsDriver["Service"]["execute"];
  readonly process: VcsProcess.VcsProcess["Service"];
  readonly remotes: JjRemoteOps;
  readonly sourceControlProviders: SourceControlProviderRegistry.SourceControlProviderRegistry["Service"];
  readonly changeRequestReads: (
    cwd: string,
  ) => Effect.Effect<ChangeRequestVcsReads, GitCommandError>;
  readonly invalidateStatus: (cwd: string) => Effect.Effect<void, never>;
}

export interface JjStackedActionOps {
  readonly runStackedAction: (
    input: GitRunStackedActionInput,
    options?: {
      readonly actionId?: string;
      readonly progressReporter?: {
        readonly publish: (event: GitActionProgressEvent) => Effect.Effect<void, never>;
      };
    },
  ) => Effect.Effect<GitRunStackedActionResult, GitManagerServiceError, ChangeRequestStepServices>;
}

export const makeJjStackedAction = (deps: JjStackedActionDeps): JjStackedActionOps => {
  const tempDir =
    globalThis.process.env.TMPDIR ??
    globalThis.process.env.TEMP ??
    globalThis.process.env.TMP ??
    "/tmp";
  const {
    changeRequestReads,
    driver,
    executeGit,
    invalidateStatus,
    process,
    remotes,
    sourceControlProviders,
  } = deps;

  const run = JjProcess.jjRunner(process);

  /** `@` against `@-`, in the shape the shared message generator reads. */
  const prepareCommitContext = (
    cwd: string,
    filePaths?: readonly string[],
    options?: { readonly includePatch?: boolean },
  ) =>
    Effect.gen(function* () {
      const operation = "JjStackedAction.prepareCommitContext";
      const paths = filesetArguments(filePaths);
      const [summary, patch] = yield* Effect.all([
        run(operation, cwd, ["diff", "-r", "@", "--stat", ...paths], {
          timeoutMs: 60_000,
          maxOutputBytes: DIFF_SUMMARY_MAX_BYTES,
          outputMode: "truncate",
        }),
        options?.includePatch === false
          ? Effect.succeed({ stdout: "" })
          : run(operation, cwd, ["diff", "-r", "@", "--git", ...paths], {
              timeoutMs: 60_000,
              maxOutputBytes: DIFF_PATCH_MAX_BYTES,
              outputMode: "truncate",
            }),
      ]).pipe(mapJjFailure(operation, cwd, "Could not read the working-copy diff."));

      return summary.stdout.trim().length === 0 && patch.stdout.trim().length === 0
        ? null
        : { stagedSummary: summary.stdout, stagedPatch: patch.stdout };
    });

  const runStackedAction: JjStackedActionOps["runStackedAction"] = Effect.fn(
    "JjStackedAction.runStackedAction",
  )(function* (input, options) {
    const cwd = input.cwd;
    const actionId = options?.actionId ?? input.actionId;
    const reporter = options?.progressReporter;
    const emit = (event: GitActionProgressPayload) =>
      reporter
        ? reporter.publish({
            actionId,
            cwd,
            action: input.action,
            ...event,
          } as GitActionProgressEvent)
        : Effect.void;

    const currentPhase = yield* Ref.make<GitActionProgressPhase | null>(null);

    const runAction = Effect.fn("JjStackedAction.runAction")(function* () {
      const settings = yield* resolveTextGenerationSettings({
        operation: "JjStackedAction.runStackedAction",
        cwd,
        ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      });

      const wantsCommit = isCommitAction(input.action);
      const wantsPr = input.action === "create_pr" || input.action === "commit_push_pr";
      const segment = yield* driver
        .currentSegment(cwd)
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<JjSegmentRow>));
      const initialRefName = yield* resolveWorkspaceRefName(driver, cwd, segment).pipe(
        Effect.mapError((cause) =>
          jjFailure(
            "JjStackedAction.runStackedAction",
            cwd,
            cause._tag === "VcsUnsupportedOperationError"
              ? cause.detail
              : "Could not resolve the workspace bookmark.",
            cause,
          ),
        ),
      );
      if (!wantsCommit && (input.action === "push" || wantsPr) && initialRefName !== null) {
        const includesWorkingCopy = yield* driver
          .countRevset(cwd, `@ & ::${localBookmarkRevset(initialRefName)}`)
          .pipe(
            mapJjFailure(
              "JjStackedAction.runStackedAction",
              cwd,
              "Could not check bookmark ancestry.",
            ),
          );
        if (includesWorkingCopy > 0) {
          return yield* Effect.fail(
            jjFailure(
              "JjStackedAction.runStackedAction",
              cwd,
              "Commit this change before pushing it or creating a change request.",
            ),
          );
        }
      }
      const upstream =
        initialRefName === null
          ? { primaryRemote: null, hasUpstream: false, defaultBookmark: null }
          : yield* resolveUpstreamContext(driver, cwd, initialRefName);
      const importedUpstream =
        input.action !== "create_pr" || initialRefName === null
          ? null
          : yield* driver.ensureUsable("JjStackedAction.runStackedAction", cwd).pipe(
              Effect.flatMap((paths) => readImportedUpstream(process, paths, initialRefName)),
              mapJjFailure(
                "JjStackedAction.runStackedAction",
                cwd,
                "Could not resolve the imported pull-request source.",
              ),
            );
      const hasImportedSource =
        importedUpstream !== null &&
        (yield* driver.listBookmarks(cwd).pipe(Effect.orElseSucceed(() => []))).some(
          (bookmark) =>
            bookmark.name === importedUpstream.branch &&
            bookmark.remote === importedUpstream.remoteName,
        );
      // Tolerant by design: a failed count must not block the action, only the create-PR shortcut.
      const initialCounts =
        initialRefName === null || (importedUpstream !== null && !hasImportedSource)
          ? { aheadCount: 0 }
          : yield* computeAheadBehindCounts(driver, cwd, {
              refName: importedUpstream?.branch ?? initialRefName,
              primaryRemote: importedUpstream?.remoteName ?? upstream.primaryRemote,
              defaultBookmark: upstream.defaultBookmark,
              hasUpstream: importedUpstream !== null || upstream.hasUpstream,
            }).pipe(Effect.orElseSucceed(() => ({ aheadCount: 0 })));
      // A missing source bookmark must not publish a private/deleted fork's local alias. When the
      // source is available, real local commits still take the protected push path and are refused.
      const wantsPush =
        input.action === "push" ||
        input.action === "commit_push" ||
        input.action === "commit_push_pr" ||
        (input.action === "create_pr" &&
          ((importedUpstream === null && !upstream.hasUpstream) || initialCounts.aheadCount > 0));

      const phases: GitActionProgressPhase[] = [
        ...(input.featureBranch ? (["branch"] as const) : []),
        ...(wantsCommit ? (["commit"] as const) : []),
        ...(wantsPush ? (["push"] as const) : []),
        ...(wantsPr ? (["pr"] as const) : []),
      ];
      yield* emit({ kind: "action_started", phases });

      // jj has no detached HEAD and no index, so git's three "Cannot ... from detached HEAD"
      // refusals and its "commit local changes first" guard have no jj equivalent: a working-copy
      // commit carrying no bookmark is the normal state, and the branch phase names it.
      const change = yield* driver
        .currentChange(cwd)
        .pipe(mapJjFailure("JjStackedAction.runStackedAction", cwd, "Could not read `@`."));
      if (change.conflict && (wantsCommit || wantsPush || wantsPr)) {
        return yield* Effect.fail(
          jjFailure(
            "JjStackedAction.runStackedAction",
            cwd,
            "Resolve conflicts in this change before committing or pushing.",
          ),
        );
      }

      let branchStep: { status: "created" | "skipped_not_requested"; name?: string } = {
        status: "skipped_not_requested" as const,
      };
      let commitMessageForStep = input.commitMessage;
      let preResolvedSuggestion: CommitAndBranchSuggestion | undefined = undefined;

      if (input.featureBranch) {
        yield* Ref.set(currentPhase, "branch");
        yield* emit({
          kind: "phase_started",
          phase: "branch",
          label: "Preparing feature branch...",
        });
        const suggestion = yield* resolveCommitAndBranchSuggestion({
          cwd,
          branch: initialRefName,
          ...(input.commitMessage ? { commitMessage: input.commitMessage } : {}),
          ...(input.filePaths ? { filePaths: input.filePaths } : {}),
          includeBranch: true,
          settings,
          executeGit,
          prepareCommitContext,
        });
        if (suggestion === null) {
          return yield* Effect.fail(
            jjFailure(
              "JjStackedAction.branchPhase",
              cwd,
              "Cannot create a bookmark because there are no changes to commit.",
            ),
          );
        }
        const bookmarks = yield* driver
          .listBookmarks(cwd)
          .pipe(mapJjFailure("JjStackedAction.branchPhase", cwd, "Could not list bookmarks."));
        const name = resolveAutoFeatureBranchName(
          bookmarks.filter((bookmark) => bookmark.remote === null).map((bookmark) => bookmark.name),
          suggestion.branch ?? suggestion.subject,
        );
        // A commit action is about to describe `@`, so the bookmark belongs on it and the commit
        // phase moves it forward; a push-only action publishes committed work, so it belongs on
        // `@-`, which is what `git branch` + `git push` do with a dirty tree.
        yield* remotes.bookmarkTo({
          cwd,
          name,
          revset: wantsCommit ? "@" : "@-",
          operation: "JjStackedAction.branchPhase",
        });
        branchStep = { status: "created" as const, name };
        commitMessageForStep = suggestion.commitMessage;
        preResolvedSuggestion = suggestion;
      }

      const refName = branchStep.name ?? initialRefName;

      const commit = wantsCommit
        ? yield* commitPhase({
            cwd,
            refName,
            settings,
            emit,
            currentPhase,
            ...(commitMessageForStep !== undefined ? { commitMessage: commitMessageForStep } : {}),
            ...(preResolvedSuggestion !== undefined ? { preResolvedSuggestion } : {}),
            ...(input.filePaths !== undefined ? { filePaths: input.filePaths } : {}),
          })
        : { status: "skipped_not_requested" as const };

      const push = wantsPush
        ? yield* Effect.gen(function* () {
            yield* Ref.set(currentPhase, "push");
            yield* emit({ kind: "phase_started", phase: "push", label: "Pushing..." });
            if (refName === null) {
              return yield* Effect.fail(
                jjFailure(
                  "JjStackedAction.pushPhase",
                  cwd,
                  "This change is not on a bookmark yet. Create one before pushing.",
                ),
              );
            }
            const remoteName = yield* remotes.requirePrimaryRemoteName(
              "JjStackedAction.pushPhase",
              cwd,
            );
            const result = yield* remotes.pushBookmark({
              cwd,
              name: refName,
              remoteName,
              operation: "JjStackedAction.pushPhase",
            });
            return {
              status: result.status,
              branch: result.refName,
              upstreamBranch: `${remoteName}/${result.refName}`,
            };
          })
        : { status: "skipped_not_requested" as const };

      const pr = wantsPr
        ? yield* Effect.gen(function* () {
            yield* Ref.set(currentPhase, "pr");
            const reads = yield* changeRequestReads(cwd);
            return yield* runChangeRequestStep({
              settings,
              cwd,
              fallbackRefName: refName,
              threadId: input.threadId,
              tempDir,
              emit,
              reads,
            });
          })
        : { status: "skipped_not_requested" as const };

      const result = {
        action: input.action,
        branch: branchStep,
        commit,
        push,
        pr,
        toast: yield* buildToast(cwd, {
          action: input.action,
          branch: branchStep,
          commit,
          push,
          pr,
        }),
      };
      yield* emit({ kind: "action_finished", result });
      return result;
    });

    return yield* runAction().pipe(
      Effect.ensuring(invalidateStatus(cwd)),
      Effect.tapError((error) =>
        Effect.flatMap(Ref.get(currentPhase), (phase) =>
          emit({ kind: "action_failed", phase, message: error.message }),
        ),
      ),
    );
  });

  const commitPhase = Effect.fn("JjStackedAction.commitPhase")(function* (input: {
    readonly cwd: string;
    readonly refName: string | null;
    readonly settings: SourceControlTextGenerationSettings;
    readonly emit: (event: GitActionProgressPayload) => Effect.Effect<void, never>;
    readonly currentPhase: Ref.Ref<GitActionProgressPhase | null>;
    readonly commitMessage?: string;
    readonly preResolvedSuggestion?: CommitAndBranchSuggestion;
    readonly filePaths?: readonly string[];
  }) {
    const operation = "JjStackedAction.commitPhase";
    yield* Ref.set(input.currentPhase, "commit");

    const change = yield* driver
      .currentChange(input.cwd)
      .pipe(mapJjFailure(operation, input.cwd, "Could not read `@`."));
    const segment = yield* driver
      .currentSegment(input.cwd)
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<JjSegmentRow>));
    const hasStrandedWork = strandedSegmentRows(segment).length > 0;

    if (change.empty && !hasStrandedWork) {
      return { status: "skipped_no_changes" as const };
    }

    // `@` is empty but the agent's own `jj commit`s sit below it: there is nothing to describe,
    // and the work reaches the remote through the bookmark move below.
    if (!change.empty) {
      const suggestion =
        change.description.trim().length > 0
          ? { commitMessage: change.description }
          : (input.preResolvedSuggestion ??
            (yield* Effect.gen(function* () {
              if (input.commitMessage === undefined || input.commitMessage.trim().length === 0) {
                yield* input.emit({
                  kind: "phase_started",
                  phase: "commit",
                  label: "Generating commit message...",
                });
              }
              return yield* resolveCommitAndBranchSuggestion({
                cwd: input.cwd,
                branch: input.refName,
                ...(input.commitMessage ? { commitMessage: input.commitMessage } : {}),
                ...(input.filePaths ? { filePaths: input.filePaths } : {}),
                settings: input.settings,
                executeGit,
                prepareCommitContext,
              });
            })));
      if (suggestion === null) {
        return { status: "skipped_no_changes" as const };
      }

      yield* input.emit({ kind: "phase_started", phase: "commit", label: "Committing..." });
      // No `hook_*` events: jj runs no Git hooks, and a `pre-commit` that inspects
      // `git diff --cached` would see an empty index and silently pass, which is worse than
      // not running it. The loss is surfaced in the client, not hidden here.
      yield* run(
        operation,
        input.cwd,
        ["commit", "-m", suggestion.commitMessage, ...filesetArguments(input.filePaths)],
        { timeoutMs: COMMIT_TIMEOUT_MS },
      ).pipe(mapJjFailure(operation, input.cwd, "Could not commit this change."));
    }

    if (input.refName !== null) {
      // `jj commit` does not move a bookmark that was on `@`, so the bookmark follows the work
      // here; the mover is forward-only, so a re-run is idempotent.
      yield* remotes.bookmarkTo({
        cwd: input.cwd,
        name: input.refName,
        revset: "@-",
        operation,
        preserveDescendants: true,
      });
    }

    const committed = yield* driver
      .changeAt(input.cwd, "@-")
      .pipe(Effect.orElseSucceed(() => null));
    return {
      status: "created" as const,
      ...(committed !== null ? { commitSha: committed.commitId } : {}),
      ...(committed !== null && committed.description.trim().length > 0
        ? { subject: committed.description.trim().split("\n")[0] ?? "" }
        : {}),
    };
  });

  const buildToast = Effect.fn("JjStackedAction.buildToast")(function* (
    cwd: string,
    result: Pick<GitRunStackedActionResult, "action" | "branch" | "commit" | "push" | "pr">,
  ) {
    const terms = yield* sourceControlProviders.resolve({ cwd }).pipe(
      Effect.map((provider) => getChangeRequestTerminologyForKind(provider.kind)),
      Effect.orElseSucceed(() =>
        getChangeRequestTerminologyForKind(SourceControlProviderKind.make("unknown")),
      ),
    );
    const summary = summarizeGitActionResult(result, terms);
    const isDefaultRef =
      result.push.branch !== undefined &&
      result.push.branch ===
        (yield* driver.resolveDefaultBookmark(cwd).pipe(Effect.orElseSucceed(() => null)));

    const cta =
      result.action === "commit" && result.commit.status === "created"
        ? { kind: "run_action" as const, label: "Push", action: { kind: "push" as const } }
        : result.pr.url
          ? { kind: "open_pr" as const, label: `View ${terms.shortLabel}`, url: result.pr.url }
          : (result.action === "push" || result.action === "commit_push") &&
              result.push.status === "pushed" &&
              !isDefaultRef
            ? {
                kind: "run_action" as const,
                label: `Create ${terms.shortLabel}`,
                action: { kind: "create_pr" as const },
              }
            : { kind: "none" as const };

    return { ...summary, cta };
  });

  return { runStackedAction };
};
