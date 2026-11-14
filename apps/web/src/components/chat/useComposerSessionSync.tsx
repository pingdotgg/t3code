import type { ChatComposerProps } from "./chatComposerTypes";
import { useComposerDraftAttachments } from "./useComposerDraftAttachments";
import { useComposerProviderModelState } from "./useComposerProviderModelState";
import { useComposerCommandState } from "./useComposerCommandState";

import {
  memo,
  use,
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  clampCollapsedComposerCursor,
  type ComposerTrigger,
  type ComposerSubmissionIntent,
  collapseExpandedComposerCursor,
  composerRequiresModifier,
  composerStateAtPromptEnd,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  formatAssistantCitationForComposer,
  isPathSuggestionCurrent,
  extendReplacementRangeForTrailingSpace,
  replaceTextRange,
} from "../../composer-logic";
import {
  shouldUseCompactComposerPrimaryActions,
  shouldUseCompactComposerFooter,
} from "../composerFooterLayout";
import { observeResize } from "~/lib/observeResize";
import { serializeComposerImages } from "./composerImagePersistence";
import {
  reconcileAttachmentContextReferences,
  useRetainedContextPayloads,
} from "./composerContextUndo";
export function useComposerSessionSync(props: ChatComposerProps, params: {
  s1: ReturnType<typeof useComposerDraftAttachments>,
  s2: ReturnType<typeof useComposerProviderModelState>,
  s3: ReturnType<typeof useComposerCommandState>,
  }) {
  const { s1, s2, s3 } = params;
  const { promptRef, draftId, activeThreadId } = props;
  const { composerMenuOpen, activeComposerMenuItemId, composerMenuSearchKey, activePendingUserInput, composerFooterHasWideActions } = s3;
  const { composerHighlightedItemId, setComposerHighlightedItemId, composerHighlightedSearchKey, setComposerHighlightedSearchKey, setComposerCursor, resetComposerTrigger, setComposerSubmissionError, setProviderInputSubmissionError, setIsDragOverComposer, composerFormRef, setIsComposerPrimaryActionsCompact } = s2;
  const { prompt, activePendingProgress, isLiteralPendingAnswer, composerImages, clearComposerDraftPersistedAttachments, attachmentDraftTarget, getComposerDraft, syncComposerDraftPersistedAttachments, composerDraftTargetKey } = s1;
    const resolvedHighlightedItemId = composerMenuOpen ? activeComposerMenuItemId : null;
    const resolvedHighlightedSearchKey = composerMenuOpen ? composerMenuSearchKey : null;
    if (composerHighlightedItemId !== resolvedHighlightedItemId) {
      setComposerHighlightedItemId(resolvedHighlightedItemId);
    }
    if (composerHighlightedSearchKey !== resolvedHighlightedSearchKey) {
      setComposerHighlightedSearchKey(resolvedHighlightedSearchKey);
    }

    const lastSyncedPendingInputRef = useRef<{
      requestId: string | null;
      questionId: string | null;
    } | null>(null);

    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves the prompt ref and caret to the end when the pending question or its answer changes externally
    useEffect(() => {
      const nextCustomAnswer = activePendingProgress?.customAnswer;
      if (typeof nextCustomAnswer !== "string") {
        if (lastSyncedPendingInputRef.current !== null) {
          promptRef.current = prompt;
          const { cursor, trigger } = composerStateAtPromptEnd(prompt);
          setComposerCursor(cursor);
          resetComposerTrigger(trigger);
        }
        lastSyncedPendingInputRef.current = null;
        return;
      }

      const nextRequestId = activePendingUserInput?.requestId ?? null;
      const nextQuestionId = activePendingProgress?.activeQuestion?.id ?? null;
      const questionChanged =
        lastSyncedPendingInputRef.current?.requestId !== nextRequestId ||
        lastSyncedPendingInputRef.current?.questionId !== nextQuestionId;
      const textChangedExternally = promptRef.current !== nextCustomAnswer;

      lastSyncedPendingInputRef.current = {
        requestId: nextRequestId,
        questionId: nextQuestionId,
      };

      if (!questionChanged && !textChangedExternally) {
        return;
      }

      promptRef.current = nextCustomAnswer;
      const { cursor, trigger } = composerStateAtPromptEnd(nextCustomAnswer, isLiteralPendingAnswer);
      setComposerCursor(cursor);
      resetComposerTrigger(trigger);
      setComposerHighlightedItemId(null);
    }, [
      activePendingProgress?.customAnswer,
      activePendingProgress?.activeQuestion?.id,
      isLiteralPendingAnswer,
      activePendingUserInput?.requestId,
      prompt,
      promptRef,
      resetComposerTrigger,
    ]);

    const composerSessionKey = `${draftId ?? ""}:${activeThreadId ?? ""}:${isLiteralPendingAnswer}`;
    const [shownComposerSessionKey, setShownComposerSessionKey] = useState(composerSessionKey);
    if (shownComposerSessionKey !== composerSessionKey) {
      setShownComposerSessionKey(composerSessionKey);
      setComposerHighlightedItemId(null);
      setComposerHighlightedSearchKey(null);
      setComposerSubmissionError(null);
      setProviderInputSubmissionError(null);
      const pendingAnswer = activePendingProgress?.customAnswer;
      const { cursor, trigger } = composerStateAtPromptEnd(
        typeof pendingAnswer === "string" ? pendingAnswer : prompt,
        isLiteralPendingAnswer,
      );
      setComposerCursor(cursor);
      resetComposerTrigger(trigger);
      setIsDragOverComposer(false);
    }

    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes composer form resizes to switch the footer and primary actions between compact layouts
    useLayoutEffect(() => {
      const composerForm = composerFormRef.current;
      if (!composerForm) return;
      const measurePrimaryActionsCompact = () => {
        const composerFormWidth = composerForm.clientWidth;
        const options = { hasWideActions: composerFooterHasWideActions };
        return (
          shouldUseCompactComposerFooter(composerFormWidth, options) &&
          shouldUseCompactComposerPrimaryActions(composerFormWidth, options)
        );
      };

      setIsComposerPrimaryActionsCompact(measurePrimaryActionsCompact());
      return observeResize(composerForm, () => {
        setIsComposerPrimaryActionsCompact(measurePrimaryActionsCompact());
      });
    }, [composerFooterHasWideActions]);

    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads draft images as data URLs and persists them to the draft store, dropping stale results on cleanup
    useEffect(() => {
      let cancelled = false;
      void (async () => {
        if (composerImages.length === 0) {
          clearComposerDraftPersistedAttachments(attachmentDraftTarget);
          return;
        }
        const getPersistedAttachmentsForThread = () =>
          getComposerDraft(attachmentDraftTarget)?.persistedAttachments ?? [];
        try {
          const currentPersistedAttachments = getPersistedAttachmentsForThread();
          const serialized = await serializeComposerImages(
            composerImages,
            currentPersistedAttachments,
          );
          if (cancelled) return;
          syncComposerDraftPersistedAttachments(attachmentDraftTarget, serialized);
        } catch {
          const currentImageIds = new Set(composerImages.map((image) => image.id));
          const fallbackPersistedAttachments = getPersistedAttachmentsForThread();
          const fallbackPersistedIds: Array<string> = [];
          for (const attachment of fallbackPersistedAttachments) {
            if (currentImageIds.has(attachment.id)) {
              fallbackPersistedIds.push(attachment.id);
            }
          }
          const fallbackPersistedIdSet = new Set(fallbackPersistedIds);
          const fallbackAttachments = fallbackPersistedAttachments.filter((attachment) =>
            fallbackPersistedIdSet.has(attachment.id),
          );
          if (cancelled) return;
          syncComposerDraftPersistedAttachments(attachmentDraftTarget, fallbackAttachments);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [
      attachmentDraftTarget,
      clearComposerDraftPersistedAttachments,
      composerImages,
      getComposerDraft,
      syncComposerDraftPersistedAttachments,
    ]);

    const retainedContextPayloads = useRetainedContextPayloads(composerDraftTargetKey);

  return { retainedContextPayloads };
}
