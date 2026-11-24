import type {
  PullRequestComment,
  PullRequestDetail,
  PullRequestReviewThread,
} from "@t3tools/contracts";

type EditingSubject = Pick<
  PullRequestDetail,
  "author" | "capabilities" | "viewer" | "viewerPermissions"
>;

function sameLogin(one: string | null | undefined, other: string | null | undefined): boolean {
  if (one == null || other == null) return false;
  return one.trim().toLowerCase() === other.trim().toLowerCase();
}

export function canEditPullRequestChangeRequest(detail: EditingSubject): boolean {
  if (detail.capabilities.edit?.changeRequest !== true) return false;
  if (detail.viewerPermissions.editChangeRequest !== undefined) {
    return detail.viewerPermissions.editChangeRequest;
  }
  return (
    sameLogin(detail.viewer, detail.author?.login) ||
    detail.viewerPermissions.actions.includes("merge")
  );
}

export function canEditPullRequestMaintainerEdits(
  detail: Pick<
    PullRequestDetail,
    "state" | "capabilities" | "viewerPermissions" | "maintainerCanModify"
  >,
): boolean {
  return (
    detail.state === "open" &&
    detail.capabilities.edit?.maintainerEdits === true &&
    detail.viewerPermissions.maintainerEdits === true &&
    detail.maintainerCanModify !== undefined
  );
}

export interface MaintainerEditsChoice {
  readonly key: string;
  readonly observedAt: number | undefined;
  readonly value: boolean;
}

/**
 * A saved choice ends at the first host reading delivered after the save. Readers refresh once it
 * succeeds, which drops reads still in flight, so that reading started after the write.
 */
export function maintainerEditsChoiceInForce<
  Choice extends { readonly key: string; readonly observedAt: number | undefined },
>(
  choice: Choice | null,
  key: string,
  observedAt: number | undefined,
  saving: boolean,
): Choice | null {
  if (choice === null || choice.key !== key) return null;
  if (saving) return choice.observedAt === observedAt ? choice : { ...choice, observedAt };
  return observedAt !== undefined && choice.observedAt === observedAt ? choice : null;
}

/** A description written from this client, shown in place of the host's copy. */
export interface DescriptionDraft {
  readonly key: string;
  readonly observedAt: number | undefined;
  /** Null once the last save failed: until a host reading, nobody knows which saves landed. */
  readonly body: string | null;
  /** Saves still running. The host applies them in order, so the last one is `body`. */
  readonly saves: number;
}

/** Same lifetime as a maintainer edits choice: until the first host reading after the saves. */
export function descriptionDraftInForce(
  draft: DescriptionDraft | null,
  key: string,
  observedAt: number | undefined,
): DescriptionDraft | null {
  return maintainerEditsChoiceInForce(draft, key, observedAt, (draft?.saves ?? 0) > 0);
}

export function startDescriptionSave(
  draft: DescriptionDraft | null,
  detail: { readonly url: string; readonly observedAt?: number | undefined },
  body: string,
): DescriptionDraft {
  const saves = draft?.key === detail.url ? draft.saves : 0;
  return { key: detail.url, observedAt: detail.observedAt, body, saves: saves + 1 };
}

/** Each save writes the whole body, so a failure only loses `body` when no later save is running. */
export function settleDescriptionSave(
  draft: DescriptionDraft | null,
  key: string,
  saved: boolean,
): DescriptionDraft | null {
  if (draft === null || draft.key !== key || draft.saves === 0) return draft;
  const saves = draft.saves - 1;
  return { ...draft, saves, body: saved || saves > 0 ? draft.body : null };
}

export function canEditPullRequestComment(
  detail: EditingSubject,
  comment: Pick<PullRequestComment, "author" | "canEdit" | "kind">,
): boolean {
  if (detail.capabilities.edit?.comment !== true) return false;
  if (comment.kind === "review" && detail.capabilities.edit.review !== true) return false;
  if (comment.canEdit !== undefined) return comment.canEdit;
  return sameLogin(detail.viewer, comment.author?.login);
}

export function canResolvePullRequestThread(
  detail: Pick<PullRequestDetail, "viewerPermissions">,
  thread: Pick<PullRequestReviewThread, "canResolve">,
): boolean {
  return detail.viewerPermissions.resolve && thread.canResolve !== false;
}

/** A comment with task ticks shown before the host confirms them. */
export interface TaskListDraft {
  /** The host's copy the ticks started from. */
  readonly base: string;
  readonly body: string;
  /** Every save has finished; the ticks now wait for a host copy other than `base`. */
  readonly settled: boolean;
}

/** Once the host's copy moves on, the ticks are dropped, so a later revert cannot revive them. */
export function taskListDraftInForce(
  draft: TaskListDraft | null,
  body: string,
): TaskListDraft | null {
  return draft === null || !draft.settled || draft.base === body ? draft : null;
}

export function startTaskListToggle(
  draft: TaskListDraft | null,
  body: string,
  next: string,
): TaskListDraft {
  return { base: draft?.base ?? body, body: next, settled: false };
}

export function settleTaskListDraft(draft: TaskListDraft | null): TaskListDraft | null {
  return draft === null ? null : { ...draft, settled: true };
}

/**
 * Runs comment saves one at a time in the order they were asked for. Each save writes the whole
 * body with every earlier tick in it, so a failure drops the saves queued behind it.
 */
export function createTaskListSaveQueue() {
  let tail = Promise.resolve();
  let generation = 0;
  let waiting = 0;
  return (
    save: () => Promise<boolean>,
    on: { readonly failed: () => void; readonly drained: () => void },
  ) => {
    const ticket = generation;
    waiting += 1;
    tail = tail
      .then(async () => {
        if (ticket !== generation || (await save().catch(() => false))) return;
        generation += 1;
        on.failed();
      })
      .then(() => {
        waiting -= 1;
        if (waiting === 0) on.drained();
      });
  };
}
