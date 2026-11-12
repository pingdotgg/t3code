import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo } from "react";
import {
  pendingReviewCommentsFromThreads,
  pendingReviewIdentityFromThreads,
  groupPendingReviewComments,
} from "@t3tools/client-runtime/review-editing";
import { AppState } from "react-native";
import * as Atom from "effect/reactivity/Atom";
import * as Schema from "effect/Schema";
import { appAtomRegistry } from "../../state/atom-registry";
import { writeFileAtomically } from "../../lib/atomic-file";
import { SerializedAsyncQueue } from "../../lib/serialized-async-queue";
import {
  EMPTY_REVIEW_DRAFT,
  ReviewDraftDocument,
  pullRequestReviewKey,
  type ReviewDraft,
  type ReviewDraftScope,
} from "./pullRequestReviewDrafts";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";

const state = Atom.make<{
  drafts: Record<string, ReviewDraft>;
  ready: boolean;
  error: string | null;
}>({ drafts: {}, ready: false, error: null }).pipe(Atom.keepAlive);
const operations = Atom.make<ReadonlySet<string>>(new Set<string>()).pipe(Atom.keepAlive);

const removedHostComments = Atom.make<Readonly<Record<string, ReadonlyArray<string>>>>({}).pipe(
  Atom.keepAlive,
);

const NO_RETIRED_COMMENTS: ReadonlyArray<string> = [];

function strictReviewDetailAtom(params: PullRequestParams) {
  const target = pullRequestTarget(params);
  return composerPullRequests.detail({ ...target, input: { ...target.input, allowStale: false } });
}

function isCurrentReviewDraftScope(scope: ReviewDraftScope) {
  const viewer = scope.viewer?.trim().toLowerCase();
  if (!viewer) return false;
  const result = appAtomRegistry.get(strictReviewDetailAtom(scope));
  return (
    result._tag === "Success" &&
    !result.waiting &&
    result.value.viewer?.trim().toLowerCase() === viewer
  );
}

export function useRetiredReviewDraftCommentIds(params: PullRequestParams) {
  const detail = useEnvironmentQuery(strictReviewDetailAtom(params));
  const retired = useAtomValue(removedHostComments);
  const viewer = !detail.isPending && !detail.error ? detail.data?.viewer?.trim() : null;
  return viewer
    ? (retired[pullRequestReviewKey(params, viewer)] ?? NO_RETIRED_COMMENTS)
    : NO_RETIRED_COMMENTS;
}

/** Keep a successful removal from reappearing in an older activity snapshot. */
export function retireReviewDraftComments(
  params: ReviewDraftScope,
  comments: ReadonlyArray<ReviewDraft["comments"][number]>,
  outdatedCommentIds: ReadonlyArray<string> = [],
) {
  const key = pullRequestReviewKey(params, params.viewer);
  const previous = appAtomRegistry.get(removedHostComments);
  appAtomRegistry.set(removedHostComments, {
    ...previous,
    [key]: [
      ...new Set([
        ...(previous[key] ?? []),
        ...outdatedCommentIds,
        ...comments.flatMap((comment) =>
          comment.hostedComment ? [comment.hostedComment.commentId] : [],
        ),
      ]),
    ],
  });
}

export function setReviewDraftBusy(params: ReviewDraftScope, busy: boolean) {
  if (busy && !params.viewer?.trim()) return false;
  const key = pullRequestReviewKey(params, params.viewer);
  const current = appAtomRegistry.get(operations);
  if (busy && current.has(key)) return false;
  const next = new Set(current);
  if (busy) next.add(key);
  else next.delete(key);
  appAtomRegistry.set(operations, next);
  return true;
}

export function readReviewDraft(params: ReviewDraftScope) {
  if (!isCurrentReviewDraftScope(params)) return EMPTY_REVIEW_DRAFT;
  return (
    appAtomRegistry.get(state).drafts[pullRequestReviewKey(params, params.viewer)] ??
    EMPTY_REVIEW_DRAFT
  );
}
const decodeDocument = Schema.decodeUnknownSync(ReviewDraftDocument);
const queue = new SerializedAsyncQueue();
let loading: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let savedDrafts: Record<string, ReviewDraft> | null = null;
async function draftFile() {
  const { Directory, File, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, "pull-request-drafts");
  directory.create({ idempotent: true, intermediates: true });
  return new File(directory, "drafts.json");
}
function load() {
  if (loading) return loading;
  loading = (async () => {
    try {
      const file = await draftFile();
      const drafts = file.exists ? decodeDocument(JSON.parse(await file.text())).drafts : {};
      savedDrafts = drafts;
      appAtomRegistry.set(state, { drafts, ready: true, error: null });
    } catch {
      appAtomRegistry.set(state, {
        ...appAtomRegistry.get(state),
        error: "Could not restore review drafts. Reopen this screen to retry.",
      });
      loading = null;
    }
  })();
  return loading;
}
async function persist() {
  if (timer) clearTimeout(timer);
  timer = null;
  return await queue.run(async () => {
    const current = appAtomRegistry.get(state);
    if (!current.ready) return false;
    if (current.drafts === savedDrafts) return true;
    try {
      const drafts = Object.fromEntries(
        Object.entries(current.drafts).filter(
          ([, draft]) => draft.summary || draft.comment || draft.comments.length,
        ),
      );
      await writeFileAtomically(await draftFile(), JSON.stringify({ version: 1, drafts }));
      savedDrafts = current.drafts;
      if (appAtomRegistry.get(state).error)
        appAtomRegistry.set(state, { ...appAtomRegistry.get(state), error: null });
      return true;
    } catch {
      appAtomRegistry.set(state, {
        ...appAtomRegistry.get(state),
        error: "Drafts are kept in this session, but could not be saved on this device.",
      });
      return false;
    }
  });
}

function updateReviewDraft(
  params: ReviewDraftScope,
  transform: (current: ReviewDraft) => ReviewDraft,
  completingOperation = false,
) {
  const key = pullRequestReviewKey(params, params.viewer);
  const current = appAtomRegistry.get(state);
  // A mutation can invalidate strict identity before its captured owner's completion arrives.
  const authorized = completingOperation
    ? Boolean(params.viewer?.trim()) && appAtomRegistry.get(operations).has(key)
    : isCurrentReviewDraftScope(params);
  if (!current.ready || !authorized) return;
  appAtomRegistry.set(state, {
    ...current,
    drafts: { ...current.drafts, [key]: transform(current.drafts[key] ?? EMPTY_REVIEW_DRAFT) },
  });
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void persist(), 200);
}

function appendRecoveredText(current: string, recovered: string) {
  return current && recovered && !current.includes(recovered)
    ? `${current}\n\n${recovered}`
    : current || recovered;
}

async function recoverLegacyDraft(scope: ReviewDraftScope) {
  if (!isCurrentReviewDraftScope(scope) || !setReviewDraftBusy(scope, true)) return false;
  try {
    const key = pullRequestReviewKey(scope, scope.viewer);
    const legacyKey = pullRequestReviewKey(scope);
    const current = appAtomRegistry.get(state);
    const legacy = current.drafts[legacyKey];
    if (!current.ready || !legacy) return false;
    const draft = current.drafts[key] ?? EMPTY_REVIEW_DRAFT;
    appAtomRegistry.set(state, {
      ...current,
      drafts: {
        ...current.drafts,
        [key]: {
          summary: appendRecoveredText(draft.summary, legacy.summary),
          comment: appendRecoveredText(draft.comment, legacy.comment),
          comments: [
            ...draft.comments,
            ...legacy.comments.filter(
              (comment) =>
                !draft.comments.some(
                  (existing) =>
                    existing.id === comment.id ||
                    (comment.hostedComment &&
                      existing.hostedComment?.commentId === comment.hostedComment.commentId),
                ),
            ),
          ],
        },
      },
    });
    if (!(await persist())) return false;
    const saved = appAtomRegistry.get(state);
    if (saved.drafts[legacyKey] === legacy) {
      const { [legacyKey]: _legacy, ...drafts } = saved.drafts;
      appAtomRegistry.set(state, { ...saved, drafts });
      return await persist();
    }
    return true;
  } finally {
    setReviewDraftBusy(scope, false);
  }
}

/** Comment menu actions subscribe without installing another app-state persistence listener. */
export function usePullRequestReviewDraftCommands(params: ReviewDraftScope) {
  const detail = useEnvironmentQuery(strictReviewDetailAtom(params));
  const viewer =
    !detail.isPending && !detail.error ? detail.data?.viewer?.trim().toLowerCase() : null;
  const snapshot = useAtomValue(state);
  const busyOperations = useAtomValue(operations);
  return {
    ready: snapshot.ready && Boolean(viewer) && viewer === params.viewer?.trim().toLowerCase(),
    isReady: () => appAtomRegistry.get(state).ready && isCurrentReviewDraftScope(params),
    busy: busyOperations.has(pullRequestReviewKey(params, params.viewer)),
    complete: (transform: (current: ReviewDraft) => ReviewDraft) =>
      updateReviewDraft(params, transform, true),
    flush: persist,
  };
}

export function usePullRequestReviewDraft(params: PullRequestParams) {
  const snapshot = useAtomValue(state);
  const busyOperations = useAtomValue(operations);
  const target = pullRequestTarget(params);
  const detail = useEnvironmentQuery(strictReviewDetailAtom(params));
  const viewer = !detail.isPending && !detail.error ? detail.data?.viewer?.trim() || null : null;
  const scope = { ...params, viewer };
  const key = pullRequestReviewKey(scope, scope.viewer);
  const activity = useEnvironmentQuery(composerPullRequests.activity(target));
  const retiredIds = useAtomValue(removedHostComments)[key];
  const draft = viewer ? (snapshot.drafts[key] ?? EMPTY_REVIEW_DRAFT) : EMPTY_REVIEW_DRAFT;
  const activityThreads = viewer ? activity.data?.reviewThreads : undefined;
  const headSha = detail.data?.headSha;
  const comments = useMemo(() => {
    const retired = new Set(retiredIds);
    for (const thread of activityThreads ?? []) {
      for (const comment of thread.comments)
        if (!comment.pendingReviewId || thread.line === null) retired.add(comment.id);
    }
    const local = draft.comments.filter(
      (comment) => !comment.hostedComment || !retired.has(comment.hostedComment.commentId),
    );
    const localIds = new Set(local.map((comment) => comment.hostedComment?.commentId));
    const remote = pendingReviewCommentsFromThreads(activityThreads ?? [])
      .filter((comment) => !localIds.has(comment.id) && !retired.has(comment.id))
      .map((comment) => ({ ...comment, headSha: headSha ?? "", code: "" }));
    return remote.length ? [...local, ...remote] : local;
  }, [draft.comments, activityThreads, headSha, retiredIds]);
  const grouped = useMemo(
    () => groupPendingReviewComments(activityThreads ?? [], comments),
    [activityThreads, comments],
  );
  const threads = grouped.threads;
  const identity = pendingReviewIdentityFromThreads(activityThreads ?? [], retiredIds);
  const pendingReviewId =
    comments.find((comment) => comment.hostedComment)?.hostedComment?.reviewId ??
    identity.pendingReviewId;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads review drafts from disk and persists them when AppState leaves active and on unmount
  useEffect(() => {
    void load();
    const listener = AppState.addEventListener("change", (phase) => {
      if (phase !== "active") void persist();
    });
    return () => {
      listener.remove();
      void persist();
    };
  }, []);
  const update = (transform: (current: ReviewDraft) => ReviewDraft) =>
    updateReviewDraft(scope, transform);
  return {
    scope,
    draft,
    legacyDraftAvailable: Boolean(scope.viewer && snapshot.drafts[pullRequestReviewKey(params)]),
    recoverLegacyDraft: () => recoverLegacyDraft(scope),
    comments,
    ungroupedComments: grouped.pendingComments,
    threads,
    activityLoaded: Boolean(viewer) && activity.data !== null,
    activityError: activity.error,
    refreshActivity: activity.refresh,
    pendingReviewId,
    outdatedComments: identity.outdatedComments,
    busy: busyOperations.has(key),
    ready: snapshot.ready && Boolean(viewer),
    isReady: () => appAtomRegistry.get(state).ready && isCurrentReviewDraftScope(scope),
    error: snapshot.error,
    update,
    complete: (transform: (current: ReviewDraft) => ReviewDraft) =>
      updateReviewDraft(scope, transform, true),
    flush: persist,
  };
}
