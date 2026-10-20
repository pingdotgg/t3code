import {
  resolveComposerDraftKey,
  useComposerDraftStore,
  type ComposerThreadTarget,
} from "~/composerDraftStore";
import { reviewCommentContextId } from "~/lib/composerContextRecords";
import type { ReviewCommentContext } from "~/reviewCommentContext";
import {
  removeInlineContextReference,
  stripInlineContextReferences,
} from "~/lib/composerContextReferences";

export interface PullRequestComposerTask {
  prompt: string;
  reviewComments?: ReadonlyArray<ReviewCommentContext>;
}

interface OwnedHandoff {
  text: string;
  snapshot: string;
  start: number;
  end: number;
  contextIds: ReadonlySet<string>;
}

// Drafts outlive the panel. Only unchanged text at the recorded insertion belongs to us.
const generalHandoffs = new Map<string, OwnedHandoff>();

function unchangedRange(previous: OwnedHandoff, prompt: string) {
  if (previous.start < 0) return null;
  const before = previous.snapshot;
  let prefix = 0;
  while (prefix < before.length && prefix < prompt.length && before[prefix] === prompt[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length &&
    suffix < prompt.length &&
    before[before.length - suffix - 1] === prompt[prompt.length - suffix - 1]
  ) {
    suffix += 1;
  }
  // Identical insertions can make either copy look unchanged, even when other prose changed.
  if (
    stripInlineContextReferences(prompt).split(previous.text).length !==
      stripInlineContextReferences(before).split(previous.text).length ||
    (prompt.length !== before.length &&
      prefix >= previous.end &&
      before.length - suffix <= previous.start)
  ) {
    return null;
  }
  let range;
  if (before.length - suffix <= previous.start) {
    const shift = prompt.length - before.length;
    range = { start: previous.start + shift, end: previous.end + shift };
  } else if (prefix >= previous.end) {
    range = { start: previous.start, end: previous.end };
  } else {
    return null;
  }
  const preceding = stripInlineContextReferences(prompt.slice(0, range.start));
  const following = stripInlineContextReferences(prompt.slice(range.end));
  // A citation is transparent to prose, including text on its other side.
  const paragraphStart = preceding.lastIndexOf("\n\n");
  const startsParagraph =
    preceding.slice(paragraphStart === -1 ? 0 : paragraphStart + 2).trim().length === 0;
  const paragraphEnd = following.indexOf("\n\n");
  const endsParagraph =
    following.slice(0, paragraphEnd === -1 ? following.length : paragraphEnd).trim().length === 0;
  return startsParagraph && endsParagraph ? range : null;
}

function handoffPrompt(prompt: string, incoming: string): string {
  if (prompt.trim().length === 0) return incoming;
  return incoming.length === 0 ? prompt : `${prompt}\n\n${incoming}`;
}

function removeHandoffPrompt(prompt: string, start: number, end: number): string {
  if (prompt[end] === " ") end += 1;
  if (prompt.slice(end, end + 2) === "\n\n") end += 2;
  else if (prompt.slice(start - 2, start) === "\n\n") start -= 2;
  return prompt.slice(0, start) + prompt.slice(end);
}

useComposerDraftStore.subscribe((state, previousState) => {
  if (state.draftsByThreadKey === previousState.draftsByThreadKey) return;
  for (const [key, owned] of generalHandoffs) {
    const draft = state.draftsByThreadKey[key];
    if (!draft) {
      generalHandoffs.delete(key);
      continue;
    }
    if (draft.prompt === owned.snapshot) continue;
    if (owned.text.length === 0) {
      generalHandoffs.delete(key);
      continue;
    }
    const range = unchangedRange(owned, draft.prompt);
    generalHandoffs.set(key, {
      ...owned,
      ...(range ?? { start: -1, end: -1 }),
      snapshot: draft.prompt,
    });
  }
});

export function writePullRequestTaskToComposer(
  target: ComposerThreadTarget,
  task: PullRequestComposerTask,
  mode: "replace" | "append" = "replace",
) {
  const store = useComposerDraftStore.getState();
  const key = resolveComposerDraftKey(store, target);
  if (!key) return;
  const draft = store.getComposerDraft(target);
  let prompt = draft?.prompt ?? "";
  const comments = draft?.reviewComments ?? [];
  const previous = generalHandoffs.get(key);
  const range = previous ? unchangedRange(previous, prompt) : null;
  if (mode === "append") {
    store.setPrompt(target, handoffPrompt(prompt, task.prompt));
    for (const comment of task.reviewComments ?? []) {
      store.addReviewComment(target, comment, {
        allowDuplicateReference: true,
        insertAtCaret: false,
      });
    }
    return;
  }

  generalHandoffs.delete(key);
  if (range) prompt = removeHandoffPrompt(prompt, range.start, range.end);
  const replaceContext = previous && (range !== null || previous.text.length === 0);
  if (replaceContext) {
    for (const contextId of previous.contextIds) {
      prompt = removeInlineContextReference(prompt, contextId).prompt;
    }
  }
  if (range?.start === 0 && prompt.startsWith("\n\n")) prompt = prompt.slice(2);
  const next = handoffPrompt(prompt, task.prompt);
  store.setPrompt(target, next);
  const incomingIds = new Set((task.reviewComments ?? []).map((comment) => comment.id));
  const retained = comments.filter(
    (comment) => !(replaceContext && previous.contextIds.has(reviewCommentContextId(comment.id))),
  );
  store.setReviewComments(target, [
    ...retained.filter((comment) => !incomingIds.has(comment.id)),
    ...(task.reviewComments ?? []),
  ]);
  generalHandoffs.set(key, {
    text: task.prompt,
    snapshot: store.getComposerDraft(target)?.prompt ?? next,
    start: task.prompt.length > 0 ? next.length - task.prompt.length : -1,
    end: task.prompt.length > 0 ? next.length : -1,
    contextIds: new Set(
      (task.reviewComments ?? [])
        .filter((comment) => !retained.some((existing) => existing.id === comment.id))
        .map((comment) => reviewCommentContextId(comment.id)),
    ),
  });
}
