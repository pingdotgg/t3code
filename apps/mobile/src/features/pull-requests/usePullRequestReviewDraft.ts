import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";
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
import type { PullRequestParams } from "./usePullRequestDiff";

const state = Atom.make<{
  drafts: Record<string, ReviewDraft>;
  ready: boolean;
  error: string | null;
}>({ drafts: {}, ready: false, error: null }).pipe(Atom.keepAlive);
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
export function usePullRequestReviewDraft(params: PullRequestParams) {
  const snapshot = useAtomValue(state);
  const key = pullRequestReviewKey(params);
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
  const update = (transform: (current: ReviewDraft) => ReviewDraft) => {
    const current = appAtomRegistry.get(state);
    if (!current.ready) return;
    appAtomRegistry.set(state, {
      ...current,
      drafts: { ...current.drafts, [key]: transform(current.drafts[key] ?? EMPTY_REVIEW_DRAFT) },
    });
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void persist(), 200);
  };
  return {
    draft: snapshot.drafts[key] ?? EMPTY_REVIEW_DRAFT,
    ready: snapshot.ready,
    error: snapshot.error,
    update,
    flush: persist,
  };
}
