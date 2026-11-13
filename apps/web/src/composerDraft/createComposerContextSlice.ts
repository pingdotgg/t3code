import { ReviewCommentContextSchema } from "../reviewCommentContext";
import {
  EnvironmentContextRecord,
  ThreadContextRecord,
  type PreviewAnnotationPayload,
} from "@t3tools/contracts";
import {
  ComposerDraftStoreGet,
  ComposerDraftStoreSet,
  ComposerDraftStoreState,
  ComposerThreadDraftState,
} from "./draftTypes";
import {
  contextInsertionHandlers,
  createEmptyThreadDraft,
  normalizeTerminalContextForThread,
  normalizeTerminalContextsForThread,
  resolveComposerDraftKey,
  resolveComposerThreadId,
  shouldRemoveDraft,
  terminalContextDedupKey,
} from "./draftStateHelpers";
import {
  appendInlineContextReference,
  ensureInlineContextReferences,
  removeInlineContextReference,
} from "../lib/composerContextReferences";
import {
  previewAnnotationContextId,
  previewAnnotationContextReference,
  reviewCommentContextId,
  reviewCommentContextReference,
  terminalContextReference,
  threadContextReference,
  environmentContextReference,
} from "../lib/composerContextRecords";
import { toKindScopedComposerContextId } from "@t3tools/shared/composerContextReferences";
import * as Schema from "effect/Schema";

const isReviewCommentContext = Schema.is(ReviewCommentContextSchema);
const isThreadContextRecord = Schema.is(ThreadContextRecord);
const isEnvironmentContextRecord = Schema.is(EnvironmentContextRecord);
export type ComposerContextSlice = Pick<
  ComposerDraftStoreState,
  | "insertTerminalContext"
  | "addTerminalContexts"
  | "removeTerminalContext"
  | "clearTerminalContexts"
  | "addPreviewAnnotation"
  | "setPreviewAnnotations"
  | "removePreviewAnnotation"
  | "addReviewComment"
  | "setContextInsertionHandler"
  | "setReviewComments"
  | "addThreadContexts"
  | "setThreadContexts"
  | "addEnvironmentContexts"
  | "setEnvironmentContexts"
  | "removeReviewComment"
>;

export function createComposerContextSlice(
  set: ComposerDraftStoreSet,
  get: ComposerDraftStoreGet,
): ComposerContextSlice {
  return {
      insertTerminalContext: (threadRef, prompt, context, index) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef);
        const threadId = resolveComposerThreadId(get(), threadRef);
        if (!threadKey || !threadId) {
          return false;
        }
        let inserted = false;
        set((state) => {
          const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
          const normalizedContext = normalizeTerminalContextForThread(threadId, context);
          if (!normalizedContext) {
            return state;
          }
          const dedupKey = terminalContextDedupKey(normalizedContext);
          if (
            existing.terminalContexts.some((entry) => entry.id === normalizedContext.id) ||
            existing.terminalContexts.some((entry) => terminalContextDedupKey(entry) === dedupKey)
          ) {
            return state;
          }
          inserted = true;
          const boundedIndex = Math.max(0, Math.min(existing.terminalContexts.length, index));
          const nextDraft: ComposerThreadDraftState = {
            ...existing,
            prompt,
            terminalContexts: [
              ...existing.terminalContexts.slice(0, boundedIndex),
              normalizedContext,
              ...existing.terminalContexts.slice(boundedIndex),
            ],
          };
          return {
            draftsByThreadKey: {
              ...state.draftsByThreadKey,
              [threadKey]: nextDraft,
            },
          };
        });
        return inserted;
      },
      addTerminalContexts: (threadRef, contexts, options) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef);
        const threadId = resolveComposerThreadId(get(), threadRef);
        if (!threadKey || !threadId || contexts.length === 0) {
          return;
        }
        const currentContexts = get().draftsByThreadKey[threadKey]?.terminalContexts ?? [];
        const incoming = normalizeTerminalContextsForThread(threadId, [
          ...currentContexts,
          ...contexts,
        ]).slice(currentContexts.length);
        if (incoming.length === 0) return;
        const placedAtCaret =
          options?.appendReference !== false &&
          options?.insertAtCaret !== false &&
          (contextInsertionHandlers.get(threadKey)?.(incoming.map(terminalContextReference)) ??
            false);
        set((state) => {
          const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
          const acceptedContexts = normalizeTerminalContextsForThread(threadId, [
            ...existing.terminalContexts,
            ...contexts,
          ]).slice(existing.terminalContexts.length);
          if (acceptedContexts.length === 0) {
            return state;
          }
          return {
            draftsByThreadKey: {
              ...state.draftsByThreadKey,
              [threadKey]: {
                ...existing,
                prompt:
                  placedAtCaret || options?.appendReference === false
                    ? existing.prompt
                    : ensureInlineContextReferences(
                        existing.prompt,
                        [...existing.terminalContexts, ...acceptedContexts].map(
                          terminalContextReference,
                        ),
                      ),
                terminalContexts: [...existing.terminalContexts, ...acceptedContexts],
              },
            },
          };
        });
      },
      removeTerminalContext: (threadRef, contextId) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
        if (threadKey.length === 0 || contextId.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByThreadKey[threadKey];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            prompt: removeInlineContextReference(
              current.prompt,
              toKindScopedComposerContextId("terminal", contextId),
            ).prompt,
            terminalContexts: current.terminalContexts.filter(
              (context) => context.id !== contextId,
            ),
          };
          const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadKey[threadKey];
          } else {
            nextDraftsByThreadKey[threadKey] = nextDraft;
          }
          return { draftsByThreadKey: nextDraftsByThreadKey };
        });
      },
      clearTerminalContexts: (threadRef) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
        if (threadKey.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByThreadKey[threadKey];
          if (!current || current.terminalContexts.length === 0) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            prompt: current.terminalContexts.reduce(
              (prompt, context) =>
                removeInlineContextReference(prompt, terminalContextReference(context).contextId)
                  .prompt,
              current.prompt,
            ),
            terminalContexts: [],
          };
          const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadKey[threadKey];
          } else {
            nextDraftsByThreadKey[threadKey] = nextDraft;
          }
          return { draftsByThreadKey: nextDraftsByThreadKey };
        });
      },
      addPreviewAnnotation: (threadRef, annotation, options) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef);
        if (!threadKey) return;
        const compactAnnotation: PreviewAnnotationPayload = {
          ...annotation,
          screenshot: annotation.screenshot ? { ...annotation.screenshot, dataUrl: "" } : null,
        };
        const reference = previewAnnotationContextReference(compactAnnotation);
        const current = get().draftsByThreadKey[threadKey];
        const alreadyPresent =
          current?.previewAnnotations.some((entry) => entry.id === annotation.id) ?? false;
        // The handler calls setPrompt; running it inside the updater would overwrite the inserted reference.
        const placedAtCaret =
          !alreadyPresent &&
          options?.appendReference !== false &&
          options?.insertAtCaret !== false &&
          (contextInsertionHandlers.get(threadKey)?.([reference]) ?? false);
        set((state) => {
          const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
          const nextAnnotations = existing.previewAnnotations.filter(
            (entry) => entry.id !== annotation.id,
          );
          return {
            draftsByThreadKey: {
              ...state.draftsByThreadKey,
              [threadKey]: {
                ...existing,
                prompt:
                  alreadyPresent || placedAtCaret || options?.appendReference === false
                    ? existing.prompt
                    : appendInlineContextReference(existing.prompt, reference),
                previewAnnotations: [...nextAnnotations, compactAnnotation],
              },
            },
          };
        });
      },
      setPreviewAnnotations: (threadRef, annotations) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef);
        if (!threadKey) return;
        set((state) => {
          const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
          const retainedIds = new Set(annotations.map((annotation) => annotation.id));
          let prompt = existing.prompt;
          for (const previous of existing.previewAnnotations) {
            if (retainedIds.has(previous.id)) continue;
            prompt = removeInlineContextReference(
              prompt,
              previewAnnotationContextId(previous.id),
            ).prompt;
          }
          prompt = ensureInlineContextReferences(
            prompt,
            annotations.map(previewAnnotationContextReference),
          );
          const nextDraft = { ...existing, prompt, previewAnnotations: [...annotations] };
          const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
          if (shouldRemoveDraft(nextDraft)) delete nextDraftsByThreadKey[threadKey];
          else nextDraftsByThreadKey[threadKey] = nextDraft;
          return { draftsByThreadKey: nextDraftsByThreadKey };
        });
      },
      removePreviewAnnotation: (threadRef, annotationId) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef);
        if (!threadKey || !annotationId) return;
        set((state) => {
          const current = state.draftsByThreadKey[threadKey];
          if (!current) return state;
          const previewAnnotations = current.previewAnnotations.filter(
            (entry) => entry.id !== annotationId,
          );
          if (previewAnnotations.length === current.previewAnnotations.length) return state;
          const nextDraft = {
            ...current,
            prompt: removeInlineContextReference(
              current.prompt,
              previewAnnotationContextId(annotationId),
            ).prompt,
            previewAnnotations,
            images: current.images.filter((image) => image.id !== annotationId),
            persistedAttachments: current.persistedAttachments.filter(
              (image) => image.id !== annotationId,
            ),
            nonPersistedImageIds: current.nonPersistedImageIds.filter(
              (imageId) => imageId !== annotationId,
            ),
          };
          const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
          if (shouldRemoveDraft(nextDraft)) delete nextDraftsByThreadKey[threadKey];
          else nextDraftsByThreadKey[threadKey] = nextDraft;
          return { draftsByThreadKey: nextDraftsByThreadKey };
        });
      },
      addReviewComment: (threadRef, comment, options) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef);
        if (!threadKey || !isReviewCommentContext(comment)) return;
        const reference = reviewCommentContextReference(comment);
        const current = get().draftsByThreadKey[threadKey];
        const alreadyPresent =
          current?.reviewComments.some((entry) => entry.id === comment.id) ?? false;
        const shouldPlaceReference =
          options?.appendReference !== false &&
          (!alreadyPresent || options?.allowDuplicateReference === true);
        // Editor insertion must finish before this update reads the draft it extends.
        const placedAtCaret =
          shouldPlaceReference &&
          options?.insertAtCaret !== false &&
          (contextInsertionHandlers.get(threadKey)?.([reference]) ?? false);
        set((state) => {
          const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
          const reviewComments = existing.reviewComments.filter(
            (entry) => entry.id !== comment.id,
          );
          return {
            draftsByThreadKey: {
              ...state.draftsByThreadKey,
              [threadKey]: {
                ...existing,
                prompt:
                  !shouldPlaceReference || placedAtCaret
                    ? existing.prompt
                    : appendInlineContextReference(existing.prompt, reference),
                reviewComments: [...reviewComments, { ...comment }],
              },
            },
          };
        });
      },
      setContextInsertionHandler: (threadRef, handler) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef);
        if (!threadKey) return;
        if (handler) contextInsertionHandlers.set(threadKey, handler);
        else contextInsertionHandlers.delete(threadKey);
        return () => {
          if (contextInsertionHandlers.get(threadKey) === handler) {
            contextInsertionHandlers.delete(threadKey);
          }
        };
      },
      setReviewComments: (threadRef, comments) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef);
        if (!threadKey) return;
        const reviewComments = comments
          .filter(isReviewCommentContext)
          .map((comment) => ({ ...comment }));
        set((state) => {
          const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
          const retainedIds = new Set(reviewComments.map((comment) => comment.id));
          let prompt = existing.prompt;
          for (const previous of existing.reviewComments) {
            if (retainedIds.has(previous.id)) continue;
            prompt = removeInlineContextReference(
              prompt,
              reviewCommentContextId(previous.id),
            ).prompt;
          }
          prompt = ensureInlineContextReferences(
            prompt,
            reviewComments.map(reviewCommentContextReference),
          );
          const nextDraft = { ...existing, prompt, reviewComments };
          const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
          if (shouldRemoveDraft(nextDraft)) delete nextDraftsByThreadKey[threadKey];
          else nextDraftsByThreadKey[threadKey] = nextDraft;
          return { draftsByThreadKey: nextDraftsByThreadKey };
        });
      },
      addThreadContexts: (threadRef, records, options) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef);
        if (!threadKey) return;
        const existingIds = new Set(
          (get().draftsByThreadKey[threadKey]?.threadContexts ?? []).map(
            (record) => record.contextId,
          ),
        );
        const incoming = records.filter((record) => {
          if (existingIds.has(record.contextId)) return false;
          existingIds.add(record.contextId);
          return true;
        });
        if (incoming.length === 0) return;
        const references = incoming.map(threadContextReference);
        const placedAtCaret =
          options?.appendReference !== false &&
          options?.insertAtCaret !== false &&
          (contextInsertionHandlers.get(threadKey)?.(references) ?? false);
        set((state) => {
          const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
          const known = new Set(existing.threadContexts.map((record) => record.contextId));
          const accepted = incoming.filter((record) => !known.has(record.contextId));
          if (accepted.length === 0) return state;
          return {
            draftsByThreadKey: {
              ...state.draftsByThreadKey,
              [threadKey]: {
                ...existing,
                prompt:
                  placedAtCaret || options?.appendReference === false
                    ? existing.prompt
                    : ensureInlineContextReferences(
                        existing.prompt,
                        accepted.map(threadContextReference),
                      ),
                threadContexts: [...existing.threadContexts, ...accepted],
              },
            },
          };
        });
      },
      setThreadContexts: (threadRef, records) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef);
        if (!threadKey) return;
        const threadContexts = records
          .filter(isThreadContextRecord)
          .map((record) => ({ ...record }));
        set((state) => {
          const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
          const retainedIds = new Set(threadContexts.map((record) => record.contextId));
          let prompt = existing.prompt;
          for (const previous of existing.threadContexts) {
            if (retainedIds.has(previous.contextId)) continue;
            prompt = removeInlineContextReference(prompt, previous.contextId).prompt;
          }
          prompt = ensureInlineContextReferences(
            prompt,
            threadContexts.map(threadContextReference),
          );
          const nextDraft = { ...existing, prompt, threadContexts };
          const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
          if (shouldRemoveDraft(nextDraft)) delete nextDraftsByThreadKey[threadKey];
          else nextDraftsByThreadKey[threadKey] = nextDraft;
          return { draftsByThreadKey: nextDraftsByThreadKey };
        });
      },
      addEnvironmentContexts: (threadRef, records, options) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef);
        if (!threadKey) return;
        const existingIds = new Set(
          (get().draftsByThreadKey[threadKey]?.environmentContexts ?? []).map(
            (record) => record.contextId,
          ),
        );
        const incoming = records.filter((record) => {
          if (existingIds.has(record.contextId)) return false;
          existingIds.add(record.contextId);
          return true;
        });
        if (incoming.length === 0) return;
        const references = incoming.map(environmentContextReference);
        const placedAtCaret =
          options?.appendReference !== false &&
          options?.insertAtCaret !== false &&
          (contextInsertionHandlers.get(threadKey)?.(references) ?? false);
        set((state) => {
          const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
          const known = new Set(existing.environmentContexts.map((record) => record.contextId));
          const accepted = incoming.filter((record) => !known.has(record.contextId));
          if (accepted.length === 0) return state;
          return {
            draftsByThreadKey: {
              ...state.draftsByThreadKey,
              [threadKey]: {
                ...existing,
                prompt:
                  placedAtCaret || options?.appendReference === false
                    ? existing.prompt
                    : ensureInlineContextReferences(
                        existing.prompt,
                        accepted.map(environmentContextReference),
                      ),
                environmentContexts: [...existing.environmentContexts, ...accepted],
              },
            },
          };
        });
      },
      setEnvironmentContexts: (threadRef, records) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef);
        if (!threadKey) return;
        const environmentContexts = records
          .filter(isEnvironmentContextRecord)
          .map((record) => ({ ...record }));
        set((state) => {
          const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
          const retainedIds = new Set(environmentContexts.map((record) => record.contextId));
          let prompt = existing.prompt;
          for (const previous of existing.environmentContexts) {
            if (retainedIds.has(previous.contextId)) continue;
            prompt = removeInlineContextReference(prompt, previous.contextId).prompt;
          }
          prompt = ensureInlineContextReferences(
            prompt,
            environmentContexts.map(environmentContextReference),
          );
          const nextDraft = { ...existing, prompt, environmentContexts };
          const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
          if (shouldRemoveDraft(nextDraft)) delete nextDraftsByThreadKey[threadKey];
          else nextDraftsByThreadKey[threadKey] = nextDraft;
          return { draftsByThreadKey: nextDraftsByThreadKey };
        });
      },
      removeReviewComment: (threadRef, commentId) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef);
        if (!threadKey || !commentId) return;
        set((state) => {
          const current = state.draftsByThreadKey[threadKey];
          if (!current) return state;
          const reviewComments = current.reviewComments.filter((entry) => entry.id !== commentId);
          if (reviewComments.length === current.reviewComments.length) return state;
          const nextDraft = {
            ...current,
            prompt: removeInlineContextReference(
              current.prompt,
              reviewCommentContextId(commentId),
            ).prompt,
            reviewComments,
          };
          const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
          if (shouldRemoveDraft(nextDraft)) delete nextDraftsByThreadKey[threadKey];
          else nextDraftsByThreadKey[threadKey] = nextDraft;
          return { draftsByThreadKey: nextDraftsByThreadKey };
        });
      },
  };
}
