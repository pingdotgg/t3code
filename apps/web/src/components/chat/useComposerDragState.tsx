import type { ChatComposerProps } from "./chatComposerTypes";
import { useComposerDraftAttachments } from "./useComposerDraftAttachments";
import { useComposerProviderModelState } from "./useComposerProviderModelState";
import { useComposerCommandState } from "./useComposerCommandState";
import { useComposerPromptEditing } from "./useComposerPromptEditing";
import { useComposerSubmissionState } from "./useComposerSubmissionState";
import { useComposerInputHandlers } from "./useComposerInputHandlers";

import {
  dataTransferHasComposerMention,
  makeComposerMentionDragHandlers,
  type ComposerMentionDragHandlers,
} from "./composerMentionDrag";
import { buildPullRequestReferenceContext } from "../pullRequest/pullRequestDetail.logic";
import {
  collectInlineContextIds,
  type ComposerContextReference,
  ensureInlineContextReferences,
  formatInlineContextReference,
  insertInlineContextReference,
  inlineContextReferenceReplacement,
} from "~/lib/composerContextReferences";
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
import { toastManager } from "../ui/toast";
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
import type {
  KeybindingCommand,
  AssistantCitation,
  ChatAttachment as ContractChatAttachment,
  ChatFileAttachment,
  EnvironmentId,
  ModelSelection,
  ProjectId,
  PreviewAnnotationPayload,
  ThreadContextRecord,
  EnvironmentContextRecord,
  ProviderInteractionMode,
  ResolvedKeybindingsConfig,
  RuntimeMode,
  RuntimeRequestId,
  ScopedThreadRef,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { pendingDraftWork } from "./pendingDraftWork";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { importComposerThreadAttachment } from "./composerThreadImport";
import { threadContextAttachment } from "~/lib/threadContextAttachment";
import {
  EnvironmentRequestInvalidError,
  AuthOrchestrationOperateScope,
  clampManagedRuntimeMode,
  managedRuntimeModeDenial,
  ProviderDriverKind,
  ProviderInstanceId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "@t3tools/contracts";
import { useThreadContextDrop, threadContextDropTargetProps } from "./threadContextDrag";
import { readThreadShell } from "~/state/entities";
import {
  threadContextRecord,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";
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
  isInsideCollapsedComposerControls,
  isInsideRestingComposerControlScope,
  markOpenToEffort,
  markOpenToPermissions,
} from "./composerEventScope";
import * as Schema from "effect/Schema";


const isEnvironmentRequestInvalidError = Schema.is(EnvironmentRequestInvalidError);

export function useComposerDragState(props: ChatComposerProps, params: {
  s1: ReturnType<typeof useComposerDraftAttachments>,
  s2: ReturnType<typeof useComposerProviderModelState>,
  s3: ReturnType<typeof useComposerCommandState>,
  s5: ReturnType<typeof useComposerPromptEditing>,
  s6: ReturnType<typeof useComposerSubmissionState>,
  s8: ReturnType<typeof useComposerInputHandlers>,
  }) {
  const { s1, s2, s3, s5, s6, s8 } = params;
  const { composerDraftTarget, routeThreadRef, environmentId, activeThreadId, setThreadError, canOperateThread, onInterrupt, onImplementPlanInNewThread } = props;
  const { insertComposerTextAtEndStable, addComposerAttachments } = s8;
  const { addComposerDraftReviewComment, countReservedAttachmentsStable, loadThreadTranscript, linkedEnvironments, addComposerDraftThreadContexts, activePendingUserInput } = s3;
  const { setIsDragOverComposer, pendingThreadImportsRef, composerFormRef, isComposerCollapsedMobile, isDragOverComposer, isMobileViewport, mobileComposerExpandInFlightRef, composerBlurFrameRef, composerSurfaceRef, setIsComposerFocused, mobileComposerExpandFrameRef, mobileComposerExpandReleaseFrameRef } = s2;
  const { attachmentTargetKey, attachmentTargetKeyRef, questionAttachmentTarget, activePendingIsResponding, activePendingProgress } = s1;
  const { readComposerSnapshotStable, applyPromptReplacementStable } = s5;
  const { expandMobileComposerStable } = s6;
    const composerMentionDragHandlers = makeComposerMentionDragHandlers({
      insertMentionAtEnd: (text) =>
        insertComposerTextAtEndStable(text, { ensureLeadingBoundary: true }),
      insertPullRequestAtEnd: (pullRequest) => {
        const comment = buildPullRequestReferenceContext(pullRequest);
        const inserted = insertComposerTextAtEndStable(
          `${formatInlineContextReference(reviewCommentContextReference(comment))} `,
          { ensureLeadingBoundary: true },
        );
        if (inserted) {
          addComposerDraftReviewComment(composerDraftTarget, comment, { appendReference: false });
        }
        return inserted;
      },
      setDragActive: setIsDragOverComposer,
      onInsertRejected: () => {
        toastManager.add({
          type: "error",
          title: "Unable to add to chat",
          description: "The composer is busy; try again once it is ready.",
        });
      },
    });

    const attachDroppedThreadFile = useEffectEvent((file: File) => addComposerAttachments([file]));
    const importDroppedThread = useEffectEvent(
      async (ref: ScopedThreadRef, isActive: () => boolean) => {
        const targetKey = attachmentTargetKey;
        pendingDraftWork.begin(targetKey);
        const loadingToast = toastManager.add({
          type: "loading",
          title: "Loading thread context…",
          timeout: 0,
          data: { threadRef: routeThreadRef, hideCopyButton: true },
        });
        const importResult = await settlePromise(() =>
          importComposerThreadAttachment({
            targetKey,
            pendingImports: pendingThreadImportsRef.current,
            countReservedAttachments: countReservedAttachmentsStable,
            load: async () => {
              const result = await loadThreadTranscript({
                environmentId: ref.environmentId,
                input: { threadId: ref.threadId },
              });
              if (result._tag !== "Success") {
                throw squashAtomCommandFailure(result);
              }
              return threadContextAttachment(ref.environmentId, result.value);
            },
            isActive,
            attach: attachDroppedThreadFile,
            onLimitReached: () => {
              if (activeThreadId) {
                setThreadError(
                  activeThreadId,
                  `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`,
                );
              }
            },
          }),
        );
        if (importResult._tag === "Failure" && isActive()) {
          const error = squashAtomCommandFailure(importResult);
          toastManager.add({
            type: "error",
            title: "Unable to read the dropped thread",
            description:
              isEnvironmentRequestInvalidError(error) &&
              error.reason === "thread_transcript_too_large"
                ? "This thread exceeds the attachment size limit. Try a shorter thread."
                : "Check that its environment is connected and up to date, then try again.",
          });
        }
        toastManager.close(loadingToast);
        pendingDraftWork.end(targetKey);
      },
    );

    useThreadContextDrop(composerFormRef, environmentId, attachmentTargetKey, (refs, isActive) => {
      const records = refs.flatMap((ref) => {
        // The agent reads a linked machine's thread itself, like the `@` picker's; any other
        // machine's comes in as its transcript.
        if (ref.environmentId !== environmentId && !linkedEnvironments.has(ref.environmentId)) {
          void importDroppedThread(
            ref,
            () => isActive() && attachmentTargetKeyRef.current === attachmentTargetKey,
          );
          return [];
        }
        const shell = readThreadShell(ref);
        return shell ? [threadContextRecord(ref, shell.title)] : [];
      });
      if (records.length === 0) return;
      if (questionAttachmentTarget !== null) {
        const canAnswer =
          canOperateThread &&
          !activePendingIsResponding &&
          activePendingProgress?.activeQuestion?.allowCustomAnswer !== false;
        const text = `${records
          .map((record) => formatInlineContextReference(threadContextReference(record)))
          .join(" ")} `;
        const snapshot = readComposerSnapshotStable();
        const cursor = snapshot.expandedCursor;
        const leadingSpace = cursor > 0 && !/\s/.test(snapshot.value[cursor - 1] ?? "");
        const inserted =
          canAnswer &&
          applyPromptReplacementStable(
            cursor,
            extendReplacementRangeForTrailingSpace(snapshot.value, cursor, text),
            leadingSpace ? ` ${text}` : text,
          );
        if (!inserted) {
          toastManager.add({
            type: "error",
            title: "Unable to add thread",
            description: "The composer is busy; try again once it is ready.",
          });
          return;
        }
        addComposerDraftThreadContexts(questionAttachmentTarget, records, {
          appendReference: false,
        });
        if (isComposerCollapsedMobile) expandMobileComposerStable();
      } else {
        addComposerDraftThreadContexts(composerDraftTarget, records);
      }
    });

    const onComposerMentionDragLeaveCapture = (event: React.DragEvent<HTMLFormElement>) => {
      if (!dataTransferHasComposerMention(event.dataTransfer.types)) return;
      event.stopPropagation();
      const nextTarget = event.relatedTarget;
      if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
      setIsDragOverComposer(false);
    };

    // Escape can cancel without dragleave; clear highlights on bubbling dragend.
    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window dragend listener clears the drop highlight when a drag is cancelled without dragleave
    useEffect(() => {
      if (!isDragOverComposer) return;
      const onWindowDragEnd = () => {
        setIsDragOverComposer(false);
      };
      window.addEventListener("dragend", onWindowDragEnd);
      return () => window.removeEventListener("dragend", onWindowDragEnd);
    }, [isDragOverComposer]);
    const handleInterruptPrimaryAction = () => {
      void onInterrupt();
    };
    const handleInterruptPrimaryActionStable = useStableCallback(handleInterruptPrimaryAction);
    const handleImplementPlanInNewThreadPrimaryAction = () => {
      void onImplementPlanInNewThread();
    };
    const handleImplementPlanInNewThreadPrimaryActionStable = useStableCallback(
      handleImplementPlanInNewThreadPrimaryAction,
    );
    const scheduleComposerCollapseCheck = () => {
      if (!isMobileViewport || mobileComposerExpandInFlightRef.current) {
        return;
      }
      if (composerBlurFrameRef.current !== null) {
        window.cancelAnimationFrame(composerBlurFrameRef.current);
      }
      composerBlurFrameRef.current = window.requestAnimationFrame(() => {
        composerBlurFrameRef.current = null;
        if (mobileComposerExpandInFlightRef.current) {
          return;
        }
        const composerSurface = composerSurfaceRef.current;
        const composerForm = composerFormRef.current;
        const activeElement = document.activeElement;
        if (isInsideRestingComposerControlScope(activeElement)) {
          return;
        }
        if (
          activeElement instanceof Node &&
          ((composerSurface && composerSurface.contains(activeElement)) ||
            (composerForm && composerForm.contains(activeElement)))
        ) {
          return;
        }
        setIsComposerFocused(false);
      });
    };
    const scheduleComposerCollapseCheckStable = useStableCallback(scheduleComposerCollapseCheck);

    // Question dismissal unmounts focused controls without firing blur.
    const activePendingUserInputRequestId = activePendingUserInput?.requestId ?? null;
    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- schedules the collapse check after a dismissed question unmounts focused controls without a blur
    useEffect(() => {
      if (activePendingUserInputRequestId !== null) return;
      scheduleComposerCollapseCheckStable();
    }, [activePendingUserInputRequestId, scheduleComposerCollapseCheckStable]);

    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels pending blur and mobile expand animation frames when the composer unmounts
    useEffect(() => {
      return () => {
        if (composerBlurFrameRef.current !== null) {
          window.cancelAnimationFrame(composerBlurFrameRef.current);
        }
        if (mobileComposerExpandFrameRef.current !== null) {
          window.cancelAnimationFrame(mobileComposerExpandFrameRef.current);
        }
        if (mobileComposerExpandReleaseFrameRef.current !== null) {
          window.cancelAnimationFrame(mobileComposerExpandReleaseFrameRef.current);
        }
      };
    }, []);

  return { composerMentionDragHandlers, onComposerMentionDragLeaveCapture, handleInterruptPrimaryActionStable, handleImplementPlanInNewThreadPrimaryActionStable, scheduleComposerCollapseCheck };
}
