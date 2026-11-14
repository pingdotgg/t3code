import type { ChatComposerProps, ChatComposerHandle } from "./chatComposerTypes";
import { useComposerDraftAttachments } from "./useComposerDraftAttachments";
import { useComposerProviderModelState } from "./useComposerProviderModelState";
import { useComposerCommandState } from "./useComposerCommandState";
import { useComposerPromptEditing } from "./useComposerPromptEditing";
import { useComposerSubmissionState } from "./useComposerSubmissionState";

import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { importPastedComposerText, readPastedComposerContext } from "../composerInlineTokenPaste";
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
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  collectInlineContextIds,
  type ComposerContextReference,
  ensureInlineContextReferences,
  formatInlineContextReference,
  insertInlineContextReference,
  inlineContextReferenceReplacement,
} from "~/lib/composerContextReferences";
import { insertAttachmentReferencesForDraft } from "./composerAttachmentReferences";
import { useComposerAttachmentIntake } from "./useComposerAttachmentIntake";
import { folderDropTarget, resolveDroppedFolderPath } from "./folderDrop";
import { isLocalEnvironmentDisabled } from "../../localEnvironment";
import { readEnvironmentScope, readPreparedConnection } from "../../state/session";
import { toastManager } from "../ui/toast";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { splitTransferredFiles } from "./workspaceFileDrop";
import {
  attachmentsToReleaseOnUploadCapabilityLoss,
  composerOtherFilesForPresentation,
  fileAttachmentCapabilityBlockReason,
  fileAttachmentStagingLimit,
  isPreviewableComposerVideo,
  shouldHandleComposerAttachmentPaste,
} from "./composerAttachmentFiles";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type DraftId,
  composerFileNeedsReattach,
  composerDraftHasUserContent,
  composerTargetKey,
  useComposerDraftStore,
  useComposerThreadDraft,
} from "../../composerDraftStore";
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


function consumePasteAsTextShortcut(deadline: { current: number }): boolean {
  const armed = Date.now() <= deadline.current;
  deadline.current = 0;
  return armed;
}

export function useComposerInputHandlers(props: ChatComposerProps, params: {
  s1: ReturnType<typeof useComposerDraftAttachments>,
  s2: ReturnType<typeof useComposerProviderModelState>,
  s3: ReturnType<typeof useComposerCommandState>,
  s5: ReturnType<typeof useComposerPromptEditing>,
  s6: ReturnType<typeof useComposerSubmissionState>,
  }) {
  const { s1, s2, s3, s5, s6 } = params;
  const { projectSelectionRequired, promptRef, composerDraftTarget, activeThreadId, supportsQuestionAttachments, composerImagesRef, composerFilesRef, setThreadError, environmentId, focusComposer } = props;
  const { activePendingIsResponding, pendingUserInputs, activePendingProgress, prompt, questionAttachmentTarget, attachmentTargetKeyRef, isLiteralPendingAnswer, attachmentTargetKey, fileStagingLimit, primaryEnvironmentId } = s1;
  const { composerEditorRef, isRevertingCheckpointRef, isComposerCollapsedMobile, pasteAsTextShortcutUntilRef } = s2;
  const { importContextFragment, setPrompt, countReservedAttachments, addComposerImage, addComposerImagesToDraft, addComposerFilesToDraft, removeComposerImageFromDraft } = s3;
  const { readComposerSnapshot, applyPromptReplacement, applyPromptReplacementStable, resolveActiveComposerTrigger } = s5;
  const { onComposerCommandKey, expandMobileComposer } = s6;
    const insertComposerText = (
      text: string,
      position: "cursor" | "end",
      options?: {
        ensureLeadingBoundary?: boolean;
        citationCommentAnchor?: AssistantCitationSourceAnchor;
        clipboardData?: DataTransfer;
      },
    ): boolean => {
      if (
        text.length === 0 ||
        activePendingIsResponding ||
        (pendingUserInputs.length > 0 && !activePendingProgress?.activeQuestion) ||
        projectSelectionRequired ||
        (options?.citationCommentAnchor && !composerEditorRef.current)
      ) {
        return false;
      }
      if (options?.clipboardData) {
        text = importPastedComposerText(options.clipboardData, importContextFragment);
      }
      const prompt = promptRef.current;
      const cursor = position === "cursor" ? readComposerSnapshot().expandedCursor : prompt.length;
      const needsLeadingSpace =
        (options?.ensureLeadingBoundary ?? false) &&
        cursor > 0 &&
        !/\s/.test(prompt[cursor - 1] ?? "");
      const rangeEnd = extendReplacementRangeForTrailingSpace(prompt, cursor, text);
      return applyPromptReplacement(
        cursor,
        rangeEnd,
        needsLeadingSpace ? ` ${text}` : text,
        options?.citationCommentAnchor
          ? {
              citationComment: {
                start: cursor + (needsLeadingSpace ? 1 : 0),
                sourceAnchor: options.citationCommentAnchor,
                insertedSpaces: { before: needsLeadingSpace, after: rangeEnd === cursor },
              },
              focusEditorAfterReplace: false,
            }
          : undefined,
      );
    };
    const insertComposerTextStable = useStableCallback(insertComposerText);

    const insertAttachmentReferences = (
      references: ReadonlyArray<ComposerContextReference>,
      selection?: { start: number; end: number },
    ): boolean => {
      if (references.length === 0) return false;
      // Question answers carry attachments beside the answer, never as chips. Falling back to
      // the thread prompt here would hide the file behind a reference the question never shows.
      if (questionAttachmentTarget) return false;
      return insertAttachmentReferencesForDraft({
        target: composerDraftTarget,
        liveAttachmentTargetKey: attachmentTargetKeyRef.current,
        references,
        insertReferences: () => {
          if (selection) {
            const edit = inlineContextReferenceReplacement(promptRef.current, selection, references);
            return applyPromptReplacementStable(edit.start, edit.end, edit.text);
          }
          const text = references.map(formatInlineContextReference).join(" ");
          const inserted = insertComposerTextStable(`${text} `, "cursor", {
            ensureLeadingBoundary: true,
          });
          if (!inserted) {
            setPrompt(ensureInlineContextReferences(promptRef.current, references));
          }
          return true;
        },
      });
    };

    const { addComposerAttachments, removeComposerImage, foldPastedText } =
      useComposerAttachmentIntake({
        activeThreadId,
        activePendingProgress,
        activePendingIsResponding,
        pendingUserInputs,
        supportsQuestionAttachments,
        isLiteralPendingAnswer,
        projectSelectionRequired,
        questionAttachmentTarget,
        attachmentTargetKey,
        fileStagingLimit,
        promptRef,
        composerImagesRef,
        composerFilesRef,
        composerEditorRef,
        isRevertingCheckpointRef,
        setThreadError,
        countReservedAttachments,
        addComposerImage,
        addComposerImagesToDraft,
        addComposerFilesToDraft,
        removeComposerImageFromDraft,
        insertAttachmentReferences,
      });

    const onComposerCommandKeyStable = useStableCallback(onComposerCommandKey);
    const isPathQueryActiveStable = useStableCallback(
      () => resolveActiveComposerTrigger().trigger?.kind === "path",
    );

    const insertComposerTextAtEnd: ChatComposerHandle["insertTextAtEnd"] = (text, options) => {
      const inserted = insertComposerText(text, "end", options);
      if (inserted && isComposerCollapsedMobile) {
        // Reveal the mobile editor before its focus frame.
        expandMobileComposer();
      }
      return inserted;
    };
    const insertComposerTextAtEndStable = useStableCallback(insertComposerTextAtEnd);

    const addComposerFolders = (folders: File[]) => {
      const target = folderDropTarget({
        localEnvironmentDisabled: isLocalEnvironmentDisabled(),
        environmentId,
        primaryEnvironmentId,
        connection: readPreparedConnection(environmentId),
        isDesktopRenderer: window.desktopBridge !== undefined,
      });
      if (target === "remote") {
        toastManager.add({
          type: "error",
          title: "Folders can only be referenced on a server running on this computer",
        });
        return;
      }
      for (const folder of folders) {
        const path = resolveDroppedFolderPath(folder, window.desktopBridge?.getPathForFile);
        if (path === null) {
          toastManager.add({
            type: "error",
            title: `Couldn't get the path of "${folder.name}"`,
            description: "Type the folder path with @ instead.",
          });
          continue;
        }
        const inserted = insertComposerTextAtEndStable(`${serializeComposerFileLink(path)} `, {
          ensureLeadingBoundary: true,
        });
        if (!inserted) {
          toastManager.add({
            type: "error",
            title: "Unable to add folder",
            description: "The composer is busy; try again once it is ready.",
          });
          break;
        }
      }
      focusComposer();
    };
    const addComposerFoldersStable = useStableCallback(addComposerFolders);

    const onComposerPaste = (event: React.ClipboardEvent<HTMLElement>) => {
      const { files, folders } = splitTransferredFiles(event.clipboardData);
      const plainText = event.clipboardData.getData("text/plain");
      const bypassAutoAttachment = consumePasteAsTextShortcut(pasteAsTextShortcutUntilRef);
      if (
        folders.length > 0 ||
        (activeThreadId &&
          files.length > 0 &&
          shouldHandleComposerAttachmentPaste({ files, plainText }))
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (folders.length > 0) addComposerFoldersStable(folders);
        if (files.length > 0) {
          void addComposerAttachments(files, { skipImageInlineChip: bypassAutoAttachment });
        }
        return;
      }

      if ((readPastedComposerContext(event.clipboardData)?.records.length ?? 0) > 0) return;
      if (!foldPastedText(plainText, bypassAutoAttachment)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
    };
    // The editor is memoized; fresh closures here re-render it on every parent
    // render, which during a stream is every delta.
    const onComposerPasteStable = useStableCallback(onComposerPaste);
    const insertContextReferencesAtCaret = (
      references: ReadonlyArray<ComposerContextReference>,
    ): boolean =>
      insertComposerText(`${references.map(formatInlineContextReference).join(" ")} `, "cursor", {
        ensureLeadingBoundary: true,
      });
    const insertContextReferencesAtCaretStable = useStableCallback(insertContextReferencesAtCaret);
    const setContextInsertionHandler = useComposerDraftStore(
      (store) => store.setContextInsertionHandler,
    );
    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers this composer's context insertion handler in the draft store for the current target
    useEffect(() => {
      return setContextInsertionHandler(composerDraftTarget, insertContextReferencesAtCaretStable);
    }, [composerDraftTarget, insertContextReferencesAtCaretStable, setContextInsertionHandler]);

  return { insertComposerTextStable, addComposerAttachments, removeComposerImage, foldPastedText, onComposerCommandKeyStable, isPathQueryActiveStable, insertComposerTextAtEndStable, addComposerFoldersStable, onComposerPasteStable };
}
