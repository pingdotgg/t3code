import type { ChatComposerProps } from "./chatComposerTypes";
import { useComposerDraftAttachments } from "./useComposerDraftAttachments";
import { useComposerProviderModelState } from "./useComposerProviderModelState";
import { useComposerCommandState } from "./useComposerCommandState";
import { useComposerSessionSync } from "./useComposerSessionSync";

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
  attachmentContextRecord,
  uploadedAttachmentContextRecord,
  previewAnnotationContextId,
  previewAnnotationContextRecord,
  reviewCommentContextId,
  reviewCommentContextReference,
  reviewCommentContextRecord,
  terminalContextReference,
  terminalContextRecord,
  threadContextReference,
  environmentContextRecord,
  environmentContextReference,
} from "~/lib/composerContextRecords";
import {
  reconcileAttachmentContextReferences,
  useRetainedContextPayloads,
} from "./composerContextUndo";
import { useStableCallback } from "../../hooks/useStableCallback";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import {
  type ComposerCitationCommentRequest,
  type ComposerPromptEditorHandle,
  ComposerPromptEditorTiptap as ComposerPromptEditor,
} from "../ComposerPromptEditorTiptap";
import {
  collectInlineContextIds,
  type ComposerContextReference,
  ensureInlineContextReferences,
  formatInlineContextReference,
  insertInlineContextReference,
  inlineContextReferenceReplacement,
} from "~/lib/composerContextReferences";
export function useComposerPromptEditing(props: ChatComposerProps, params: {
  s1: ReturnType<typeof useComposerDraftAttachments>,
  s2: ReturnType<typeof useComposerProviderModelState>,
  s3: ReturnType<typeof useComposerCommandState>,
  s4: ReturnType<typeof useComposerSessionSync>,
  }) {
  const { s1, s2, s3, s4 } = params;
  const { onChangeActivePendingUserInputCustomAnswer, promptRef, composerDraftTarget } = props;
  const { refreshWorkspaceSnapshotOnTyping, setComposerCursor, setComposerTrigger, promptHistoryPositionRef, composerEditorRef, composerCursor, resolveComposerTrigger } = s2;
  const { activePendingProgress, pendingUserInputs, onTypingGuardDraftChange, composerTerminalContexts, setComposerDraftTerminalContexts, composerThreadContexts, composerEnvironmentContexts, composerReviewComments, removeComposerDraftReviewComment, composerFiles, composerImages, composerPreviewAnnotations, removeComposerDraftPreviewAnnotation, addComposerDraftImages, attachmentDraftTarget, removeComposerDraftFile, addComposerDraftFiles, isLiteralPendingAnswer } = s1;
  const { setPrompt, setComposerDraftThreadContexts, setComposerDraftEnvironmentContexts, addComposerDraftReviewComment, addComposerDraftPreviewAnnotation, activePendingUserInput } = s3;
  const { retainedContextPayloads } = s4;
    const onPromptChange = (
      nextPrompt: string,
      nextCursor: number,
      expandedCursor: number,
      cursorAdjacentToMention: boolean,
      contextIds: string[],
    ) => {
      refreshWorkspaceSnapshotOnTyping();
      if (activePendingProgress?.activeQuestion && pendingUserInputs.length > 0) {
        if (activePendingProgress.activeQuestion.allowCustomAnswer === false) return;
        setComposerCursor(nextCursor);
        setComposerTrigger(
          cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
        );
        onChangeActivePendingUserInputCustomAnswer(
          activePendingProgress.activeQuestion.id,
          nextPrompt,
          nextCursor,
          expandedCursor,
          cursorAdjacentToMention,
        );
        return;
      }
      onTypingGuardDraftChange();
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      if (promptHistoryPositionRef.current?.position.recalled !== nextPrompt) {
        promptHistoryPositionRef.current = null;
      }
      const referenced = new Set(contextIds);
      const retained = retainedContextPayloads;

      const liveTerminalIds = new Set<string>(
        composerTerminalContexts.map((context) => terminalContextReference(context).contextId),
      );
      const restoredTerminals = [...referenced].flatMap((contextId) => {
        if (liveTerminalIds.has(contextId)) return [];
        const context = retained.terminals.get(contextId);
        return context ? [context] : [];
      });
      const nextTerminals = [
        ...composerTerminalContexts.filter((context) =>
          referenced.has(terminalContextReference(context).contextId),
        ),
        ...restoredTerminals,
      ];
      for (const context of composerTerminalContexts) {
        const contextId = terminalContextReference(context).contextId;
        if (!referenced.has(contextId)) retained.terminals.set(contextId, context);
      }
      if (nextTerminals.length !== composerTerminalContexts.length || restoredTerminals.length > 0) {
        setComposerDraftTerminalContexts(composerDraftTarget, nextTerminals);
      }

      const liveThreadIds = new Set<string>(composerThreadContexts.map((record) => record.contextId));
      const restoredThreads = [...referenced].flatMap((contextId) => {
        if (liveThreadIds.has(contextId)) return [];
        const record = retained.threads.get(contextId);
        return record ? [record] : [];
      });
      const nextThreads = [
        ...composerThreadContexts.filter((record) => referenced.has(record.contextId)),
        ...restoredThreads,
      ];
      for (const record of composerThreadContexts) {
        if (!referenced.has(record.contextId)) retained.threads.set(record.contextId, record);
      }
      if (nextThreads.length !== composerThreadContexts.length || restoredThreads.length > 0) {
        setComposerDraftThreadContexts(composerDraftTarget, nextThreads);
      }

      const liveEnvironmentIds = new Set<string>(
        composerEnvironmentContexts.map((record) => record.contextId),
      );
      const restoredEnvironments = [...referenced].flatMap((contextId) => {
        if (liveEnvironmentIds.has(contextId)) return [];
        const record = retained.environments.get(contextId);
        return record ? [record] : [];
      });
      const nextEnvironments = [
        ...composerEnvironmentContexts.filter((record) => referenced.has(record.contextId)),
        ...restoredEnvironments,
      ];
      for (const record of composerEnvironmentContexts) {
        if (!referenced.has(record.contextId)) retained.environments.set(record.contextId, record);
      }
      if (
        nextEnvironments.length !== composerEnvironmentContexts.length ||
        restoredEnvironments.length > 0
      ) {
        setComposerDraftEnvironmentContexts(composerDraftTarget, nextEnvironments);
      }

      for (const comment of composerReviewComments) {
        const contextId = reviewCommentContextId(comment.id);
        if (!referenced.has(contextId)) {
          retained.reviewComments.set(contextId, comment);
          removeComposerDraftReviewComment(composerDraftTarget, comment.id);
        }
      }
      const liveReviewIds = new Set<string>(
        composerReviewComments.map((comment) => reviewCommentContextId(comment.id)),
      );
      for (const contextId of referenced) {
        if (liveReviewIds.has(contextId)) continue;
        const comment = retained.reviewComments.get(contextId);
        if (comment) {
          addComposerDraftReviewComment(composerDraftTarget, comment, { appendReference: false });
        }
      }

      const attachmentChanges = reconcileAttachmentContextReferences({
        referencedContextIds: referenced,
        files: composerFiles,
        images: composerImages,
        previewAnnotations: composerPreviewAnnotations,
        retained: retainedContextPayloads,
      });
      for (const annotationId of attachmentChanges.annotationIdsToRemove) {
        removeComposerDraftPreviewAnnotation(composerDraftTarget, annotationId);
      }
      for (const restored of attachmentChanges.annotationsToRestore) {
        if (restored.image) addComposerDraftImages(attachmentDraftTarget, [restored.image]);
        addComposerDraftPreviewAnnotation(composerDraftTarget, restored.annotation, {
          appendReference: false,
        });
      }
      for (const fileId of attachmentChanges.filesToRemove) {
        removeComposerDraftFile(attachmentDraftTarget, fileId);
      }
      if (attachmentChanges.filesToRestore.length > 0) {
        addComposerDraftFiles(attachmentDraftTarget, attachmentChanges.filesToRestore);
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(
        cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
      );
    };
    const onPromptChangeStable = useStableCallback(onPromptChange);

    const applyPromptReplacement = (
      rangeStart: number,
      rangeEnd: number,
      replacement: string,
      options?: {
        expectedText?: string;
        expandedCursorAfterReplace?: number;
        focusEditorAfterReplace?: boolean;
        citationComment?: {
          start: number;
          sourceAnchor: AssistantCitationSourceAnchor;
          insertedSpaces: ComposerCitationCommentRequest["insertedSpaces"];
        };
      },
    ): boolean => {
      if (
        activePendingUserInput &&
        activePendingProgress?.activeQuestion?.allowCustomAnswer === false
      ) {
        return false;
      }
      const currentText = promptRef.current;
      const safeStart = Math.max(0, Math.min(currentText.length, rangeStart));
      const safeEnd = Math.max(safeStart, Math.min(currentText.length, rangeEnd));
      if (
        options?.expectedText !== undefined &&
        currentText.slice(safeStart, safeEnd) !== options.expectedText
      ) {
        return false;
      }
      const next = replaceTextRange(promptRef.current, rangeStart, rangeEnd, replacement);
      const nextCursor = collapseExpandedComposerCursor(
        next.text,
        options?.expandedCursorAfterReplace ?? next.cursor,
        isLiteralPendingAnswer,
      );
      const nextExpandedCursor = expandCollapsedComposerCursor(
        next.text,
        nextCursor,
        isLiteralPendingAnswer,
      );
      if (options?.citationComment) {
        composerEditorRef.current?.requestCitationComment({
          previousValue: currentText,
          value: next.text,
          citationStart: options.citationComment.start,
          sourceAnchor: options.citationComment.sourceAnchor,
          insertedSpaces: options.citationComment.insertedSpaces,
        });
      }
      promptRef.current = next.text;
      const activePendingQuestion = activePendingProgress?.activeQuestion;
      if (activePendingQuestion && activePendingUserInput) {
        onChangeActivePendingUserInputCustomAnswer(
          activePendingQuestion.id,
          next.text,
          nextCursor,
          nextExpandedCursor,
          isLiteralPendingAnswer,
        );
      } else {
        setPrompt(next.text);
        onTypingGuardDraftChange();
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(
        isLiteralPendingAnswer ? null : detectComposerTrigger(next.text, nextExpandedCursor),
      );
      if (options?.focusEditorAfterReplace !== false) {
        window.requestAnimationFrame(() => {
          if (promptRef.current !== next.text) return;
          composerEditorRef.current?.focusAt(nextCursor);
        });
      }
      return true;
    };
    const applyPromptReplacementStable = useStableCallback(applyPromptReplacement);

    const readComposerSnapshot = (): {
      value: string;
      cursor: number;
      expandedCursor: number;
      contextIds: string[];
    } => {
      const editorSnapshot = composerEditorRef.current?.readSnapshot();
      if (editorSnapshot) {
        return editorSnapshot;
      }
      return {
        value: promptRef.current,
        cursor: composerCursor,
        expandedCursor: expandCollapsedComposerCursor(
          promptRef.current,
          composerCursor,
          isLiteralPendingAnswer,
        ),
        contextIds: isLiteralPendingAnswer ? [] : collectInlineContextIds(promptRef.current),
      };
    };
    const readComposerSnapshotStable = useStableCallback(readComposerSnapshot);

    const resolveActiveComposerTrigger = (): {
      snapshot: { value: string; cursor: number; expandedCursor: number };
      trigger: ComposerTrigger | null;
    } => {
      const snapshot = readComposerSnapshot();
      return {
        snapshot,
        trigger: isLiteralPendingAnswer
          ? null
          : resolveComposerTrigger(detectComposerTrigger(snapshot.value, snapshot.expandedCursor)),
      };
    };

  return { onPromptChangeStable, applyPromptReplacement, applyPromptReplacementStable, readComposerSnapshot, readComposerSnapshotStable, resolveActiveComposerTrigger };
}
