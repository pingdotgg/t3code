/**
 * fork: f4 source-control panel — the diff surface on a draft thread.
 *
 * The defect these rules exist for: clicking a changed file in the source
 * control panel of a brand-new thread switched the right panel to Diff and
 * rendered *"Select a thread to inspect turn diffs."* — the working copy
 * selection never displayed at all.
 *
 * Two things go wrong on a draft, both from one cause: a draft route is
 * `/draft/$draftId` and carries no `environmentId`/`threadId` params.
 *
 *  1. `DiffPanel` resolves its thread ref from route params, so it resolves
 *     `null`, while `ChatView` writes the diff selection and opens the right
 *     panel under the draft's *reserved* thread ref. The selection was written
 *     under a key the panel never read.
 *  2. `useThread(null)` is `null`, so the panel had no environment and no cwd,
 *     and fell through to its "no thread" empty state.
 *
 * Neither the working-copy diff nor a commit's file diff depends on a turn —
 * both read `workingCopy.*` for one environment and one cwd — so recovering
 * those three values from the draft session is all that was ever missing.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";

export interface DraftDiffTarget {
  /** The ref `ChatView` keys the diff selection and the right panel by. */
  readonly threadRef: ScopedThreadRef | null;
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
}

export const NO_DRAFT_DIFF_TARGET: DraftDiffTarget = {
  threadRef: null,
  environmentId: null,
  cwd: null,
};

/**
 * The draft session fields a file-scoped diff needs. Narrower than
 * `DraftSessionState` on purpose — nothing here wants the composer's state.
 */
export interface DraftDiffSession {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly worktreePath: string | null;
}

export function resolveDraftDiffTarget(
  draft: DraftDiffSession | null,
  project: { readonly workspaceRoot: string } | null,
): DraftDiffTarget {
  if (draft === null) return NO_DRAFT_DIFF_TARGET;
  return {
    // The reserved thread id is the one ChatView keys by from the first render,
    // long before the thread exists on the server.
    threadRef: scopeThreadRef(draft.environmentId, draft.threadId),
    environmentId: draft.environmentId,
    // A draft can already own a worktree (`envMode: "worktree"`), and that is
    // the working copy its changes live in.
    cwd:
      project === null
        ? null
        : projectScriptCwd({
            project: { cwd: project.workspaceRoot },
            worktreePath: draft.worktreePath,
          }),
  };
}

/**
 * Whether `DiffPanel` should render *"Select a thread to inspect turn diffs."*
 *
 * Only the turn and branch scopes need a thread. A file-scoped diff (a working
 * copy file, or one file of a commit) is fetched from `workingCopy.*` with an
 * environment and a cwd, so it must render on a thread that has no turns — and
 * on a draft, which has no server thread at all.
 */
export function showsSelectThreadEmptyState(input: {
  readonly hasThread: boolean;
  readonly fileScopedDiffActive: boolean;
}): boolean {
  return !input.hasThread && !input.fileScopedDiffActive;
}
