import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo } from "react";
import { pendingReviewCommentsFromThreads } from "@t3tools/client-runtime/review-editing";
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

/** Keep a successful removal from reappearing in an older activity snapshot. */
export function retireReviewDraftComments(
  params: PullRequestParams,
  comments: ReadonlyArray<ReviewDraft["comments"][number]>,
) {
  const key = pullRequestReviewKey(params);
  const previous = appAtomRegistry.get(removedHostComments);
  appAtomRegistry.set(removedHostComments, {
    ...previous,
    [key]: [
      ...new Set([
        ...(previous[key] ?? []),
        ...comments.flatMap((comment) =>
          comment.hostedComment ? [comment.hostedComment.commentId] : [],
        ),
      ]),
    ],
  });
}

export function setReviewDraftBusy(params: PullRequestParams, busy: boolean) {
  const key = pullRequestReviewKey(params);
  const current = appAtomRegistry.get(operations);
  if (busy && current.has(key)) return false;
  const next = new Set(current);
  if (busy) next.add(key);
  else next.delete(key);
  appAtomRegistry.set(operations, next);
  return true;
}

export function readReviewDraft(params: PullRequestParams) {
  return appAtomRegistry.get(state).drafts[pullRequestReviewKey(params)] ?? EMPTY_REVIEW_DRAFT;
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
  await queue.run(async () => {
    const current = appAtomRegistry.get(state);
    if (!current.ready || current.drafts === savedDrafts) return;
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
    } catch {
      appAtomRegistry.set(state, {
        ...appAtomRegistry.get(state),
        error: "Drafts are kept in this session, but could not be saved on this device.",
      });
    }
  });
}

function updateReviewDraft(
  params: PullRequestParams,
  transform: (current: ReviewDraft) => ReviewDraft,
) {
  const key = pullRequestReviewKey(params);
  const current = appAtomRegistry.get(state);
  if (!current.ready) return;
  appAtomRegistry.set(state, {
    ...current,
    drafts: { ...current.drafts, [key]: transform(current.drafts[key] ?? EMPTY_REVIEW_DRAFT) },
  });
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void persist(), 200);
}

/** Comment menu actions subscribe without installing another app-state persistence listener. */
export function usePullRequestReviewDraftCommands(params: PullRequestParams) {
  const snapshot = useAtomValue(state);
  const busyOperations = useAtomValue(operations);
  return {
    ready: snapshot.ready,
    busy: busyOperations.has(pullRequestReviewKey(params)),
    update: (transform: (current: ReviewDraft) => ReviewDraft) =>
      updateReviewDraft(params, transform),
    flush: persist,
  };
}

export function usePullRequestReviewDraft(params: PullRequestParams) {
  const snapshot = useAtomValue(state);
  const busyOperations = useAtomValue(operations);
  const key = pullRequestReviewKey(params);
  const target = pullRequestTarget(params);
  const detail = useEnvironmentQuery(composerPullRequests.detail(target));
  const activity = useEnvironmentQuery(composerPullRequests.activity(target));
  const retiredIds = useAtomValue(removedHostComments)[key];
  const draft = snapshot.drafts[key] ?? EMPTY_REVIEW_DRAFT;
  const comments = useMemo(() => {
    const retired = new Set(retiredIds);
    for (const thread of activity.data?.reviewThreads ?? []) {
      for (const comment of thread.comments) if (!comment.pendingReviewId) retired.add(comment.id);
    }
    const local = draft.comments.filter(
      (comment) => !comment.hostedComment || !retired.has(comment.hostedComment.commentId),
    );
    const localIds = new Set(local.map((comment) => comment.hostedComment?.commentId));
    const remote = pendingReviewCommentsFromThreads(activity.data?.reviewThreads ?? [])
      .filter((comment) => !localIds.has(comment.id) && !retired.has(comment.id))
      .map((comment) => ({ ...comment, headSha: detail.data?.headSha ?? "", code: "" }));
    return remote.length ? [...local, ...remote] : local;
  }, [draft.comments, activity.data?.reviewThreads, detail, retiredIds]);
  const threads = useMemo(() => {
    return (activity.data?.reviewThreads ?? []).flatMap((thread) => {
      const published = thread.comments.filter((comment) => !comment.pendingReviewId);
      return published.length ? [{ ...thread, comments: published }] : [];
    });
  }, [activity.data?.reviewThreads]);
  const pendingReviewId = comments.find((comment) => comment.hostedComment)?.hostedComment
    ?.reviewId;
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
    updateReviewDraft(params, transform);
  return {
    draft,
    comments,
    threads,
    activityLoaded: activity.data !== null,
    activityError: activity.error,
    refreshActivity: activity.refresh,
    pendingReviewId,
    busy: busyOperations.has(key),
    ready: snapshot.ready,
    error: snapshot.error,
    update,
    flush: persist,
  };
}
