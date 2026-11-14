import type { ChatComposerProps } from "./chatComposerTypes";
import { useComposerDraftAttachments } from "./useComposerDraftAttachments";
import { useComposerProviderModelState } from "./useComposerProviderModelState";
import { useComposerCommandState } from "./useComposerCommandState";
import { useComposerPromptEditing } from "./useComposerPromptEditing";

import {
  type ComposerCommandItem,
  ComposerCommandMenu,
  composerSuggestionOptionId,
} from "./ComposerCommandMenu";
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
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { USAGE_LIMITS_COMMAND } from "@t3tools/shared/usageLimits";
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
import { readThreadShell } from "~/state/entities";
import {
  threadContextRecord,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  resolveComposerDispatchMode,
  type ComposerDispatchMode,
} from "@t3tools/client-runtime/state/composer-dispatch";
import { readEnvironmentScope, readPreparedConnection } from "../../state/session";
import {
  EnvironmentRequestInvalidError,
  AuthOrchestrationOperateScope,
  clampManagedRuntimeMode,
  managedRuntimeModeDenial,
  ProviderDriverKind,
  ProviderInstanceId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "@t3tools/contracts";
import {
  countPreparingComposerImages,
  usePreparingComposerImages,
} from "./preparingComposerImages";
import { toastManager } from "../ui/toast";
import { pendingDraftWork } from "./pendingDraftWork";
import {
  getComposerPromptLengthValidationMessage,
  getComposerSubmissionValidationMessage,
  submitComposerDraft,
} from "./composerSubmission";
import { composerCommandKeyHandler } from "./composerCommandKey";
export function useComposerSubmissionState(props: ChatComposerProps, params: {
  s1: ReturnType<typeof useComposerDraftAttachments>,
  s2: ReturnType<typeof useComposerProviderModelState>,
  s3: ReturnType<typeof useComposerCommandState>,
  s5: ReturnType<typeof useComposerPromptEditing>,
  }) {
  const { s1, s2, s3, s5 } = params;
  const { environmentId, gitCwd, handleInteractionModeChange, composerDraftTarget, isSendBusy, environmentUnavailable, phase, activePendingResolvedAnswers, showPlanFollowUpPrompt, activeThreadId, promptRef, onSend, isCompacting, compactDisabled, onCompactContext, keybindings, settings, routeKind, promptHistoryEntries, composerImagesRef, composerFilesRef, composerTerminalContextsRef, toggleInteractionMode } = props;
  const { composerSelectLockRef, setComposerHighlightedItemId, setIsComposerModelPickerOpen, planModeUiEnabled, composerMenuItemsRef, setComposerHighlightedSearchKey, composerHighlightedItemId, isSoftwareKeyboardOpen, composerBlurFrameRef, setIsComposerFocused, isSendDisabled, noProviderAvailable, providerInputRejectedRef, setComposerSubmissionError, mobileComposerExpandFrameRef, mobileComposerExpandReleaseFrameRef, mobileComposerExpandInFlightRef, composerEditorRef, promptHistoryPositionRef, composerMenuOpenRef, activeComposerMenuItemRef, setComposerCursor, setComposerTrigger, dismissComposerTrigger } = s2;
  const { resolveActiveComposerTrigger, applyPromptReplacement, readComposerSnapshot } = s5;
  const { addComposerDraftReviewComment, addComposerDraftThreadContexts, addComposerDraftEnvironmentContexts, composerMenuSearchKey, composerMenuItems, composerSendState, followUpBehavior, setPrompt } = s3;
  const { attachmentDraftTarget, activePendingProgress, attachmentTargetKey, prompt, onTypingGuardSend, activePendingApproval, pendingUserInputs, isLiteralPendingAnswer, composerPreviewAnnotations, composerReviewComments, setComposerDraftPrompt } = s1;
    const { onUsageLimitsCommand } = props;
    const onSelectComposerItem = (item: ComposerCommandItem) => {
      if (composerSelectLockRef.current) return;
      composerSelectLockRef.current = true;
      window.requestAnimationFrame(() => {
        composerSelectLockRef.current = false;
      });
      const { snapshot, trigger } = resolveActiveComposerTrigger();
      if (!trigger) return;
      if (item.type === "path") {
        if (!isPathSuggestionCurrent(item.searchTarget, trigger, environmentId, gitCwd)) return;
        const replacement = `${serializeComposerFileLink(item.path)} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(trigger.rangeStart, replacementRangeEnd, replacement, {
          expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
        });
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "slash-command") {
        if (item.command === "model") {
          const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
            expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
            focusEditorAfterReplace: false,
          });
          if (applied) {
            setComposerHighlightedItemId(null);
            setIsComposerModelPickerOpen(true);
          }
          return;
        }
        if (item.command === "side" || item.command === "btw") {
          if (props.sideChatDisabledReason) return;
          const applied = applyPromptReplacement(
            trigger.rangeStart,
            trigger.rangeEnd,
            `/${item.command} `,
            { expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd) },
          );
          if (applied) setComposerHighlightedItemId(null);
          return;
        }
        if (!planModeUiEnabled) return;
        void handleInteractionModeChange(item.command === "plan" ? "plan" : "default");
        const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
          expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
        });
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "provider-slash-command") {
        if (item.command.name === USAGE_LIMITS_COMMAND.name && onUsageLimitsCommand) {
          const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
            expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
            focusEditorAfterReplace: false,
          });
          if (applied) {
            setComposerHighlightedItemId(null);
            onUsageLimitsCommand();
          }
          return;
        }
        const replacement = `/${item.command.name} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(trigger.rangeStart, replacementRangeEnd, replacement, {
          expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
        });
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "skill") {
        const replacement = `$${item.skill.name} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(trigger.rangeStart, replacementRangeEnd, replacement, {
          expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
        });
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "pull-request") {
        if (
          trigger.kind !== "pull-request" ||
          !composerMenuItemsRef.current.some((candidate) => candidate.id === item.id)
        ) {
          return;
        }
        const comment = buildPullRequestReferenceContext(item.pullRequest);
        const replacement = `${formatInlineContextReference(
          reviewCommentContextReference(comment),
        )} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(trigger.rangeStart, replacementRangeEnd, replacement, {
          expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
        });
        if (applied) {
          addComposerDraftReviewComment(composerDraftTarget, comment, {
            appendReference: false,
          });
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "thread") {
        if (trigger.kind !== "path") return;
        const shell = readThreadShell(item.thread);
        if (!shell) return;
        const record = threadContextRecord(item.thread, shell.title);
        const replacement = `${formatInlineContextReference(threadContextReference(record))} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(trigger.rangeStart, replacementRangeEnd, replacement, {
          expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
        });
        if (applied) {
          addComposerDraftThreadContexts(attachmentDraftTarget, [record], {
            appendReference: false,
          });
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "environment") {
        if (trigger.kind !== "path") return;
        const record = environmentContextRecord(item.environmentId, item.label);
        const replacement = `${formatInlineContextReference(environmentContextReference(record))} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(trigger.rangeStart, replacementRangeEnd, replacement, {
          expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
        });
        if (applied) {
          addComposerDraftEnvironmentContexts(composerDraftTarget, [record], {
            appendReference: false,
          });
          setComposerHighlightedItemId(null);
        }
        return;
      }
    };
    const onSelectComposerItemStable = useStableCallback(onSelectComposerItem);

    const onComposerMenuItemHighlighted = (itemId: string | null) => {
      setComposerHighlightedItemId(itemId);
      setComposerHighlightedSearchKey(composerMenuSearchKey);
    };
    const onComposerMenuItemHighlightedStable = useStableCallback(onComposerMenuItemHighlighted);

    const nudgeComposerMenuHighlight = (key: "ArrowDown" | "ArrowUp") => {
      if (composerMenuItems.length === 0) return;
      const highlightedIndex = composerMenuItems.findIndex(
        (item) => item.id === composerHighlightedItemId,
      );
      const normalizedIndex = highlightedIndex >= 0 ? highlightedIndex : key === "ArrowDown" ? -1 : 0;
      const offset = key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        (normalizedIndex + offset + composerMenuItems.length) % composerMenuItems.length;
      const nextItem = composerMenuItems[nextIndex];
      setComposerHighlightedItemId(nextItem?.id ?? null);
    };

    const blurMobileComposerAfterSend = () => {
      if (!isSoftwareKeyboardOpen) return;
      if (composerBlurFrameRef.current !== null) {
        window.cancelAnimationFrame(composerBlurFrameRef.current);
        composerBlurFrameRef.current = null;
      }
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement) {
        activeElement.blur();
      }
      setIsComposerFocused(false);
    };

    const shouldBlurMobileComposerOnSubmit = () => {
      if (!isSoftwareKeyboardOpen) return false;
      if (
        isSendBusy ||
        isSendDisabled ||
        noProviderAvailable ||
        environmentUnavailable !== null ||
        phase === "running"
      ) {
        return false;
      }
      if (activePendingProgress) {
        return activePendingProgress.isLastQuestion && Boolean(activePendingResolvedAnswers);
      }
      return showPlanFollowUpPrompt || composerSendState.hasSendableContent;
    };

    const submitComposer = (
      event?: { preventDefault: () => void },
      dispatchMode?: ComposerDispatchMode,
      submissionIntent?: ComposerSubmissionIntent,
    ) => {
      if (
        noProviderAvailable ||
        isSendDisabled ||
        !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
      ) {
        event?.preventDefault();
        return;
      }
      // A send while a pasted image is still compressing would strand that image:
      // the turn snapshot wouldn't include it, and it would surface in the *next*
      // draft instead.
      if (activeThreadId && countPreparingComposerImages(attachmentTargetKey) > 0) {
        event?.preventDefault();
        toastManager.add({
          type: "info",
          title: "Still compressing a pasted image.",
          description: "Send again once its thumbnail appears.",
        });
        return;
      }
      if (pendingDraftWork.has(attachmentTargetKey)) {
        event?.preventDefault();
        toastManager.add({
          type: "info",
          title: "Still bringing attached context into this message.",
          description: "Send again once its chip resolves.",
        });
        return;
      }
      const submission = submitComposerDraft({
        prompt: promptRef.current,
        submissionTarget: activePendingProgress ? "pending-user-input" : "provider-turn",
        event,
        onSend: (sendEvent) => {
          providerInputRejectedRef.current = false;
          onSend(
            sendEvent,
            dispatchMode ??
              resolveComposerDispatchMode({
                running: phase === "running",
                alternateModifier: false,
                activeTurnDefault: followUpBehavior,
                canSteer: !isCompacting,
              }),
            submissionIntent,
          );
          return !providerInputRejectedRef.current;
        },
      });
      setComposerSubmissionError(submission.validationMessage);
      if (!submission.didDispatch) return;
      onTypingGuardSend();
      if (shouldBlurMobileComposerOnSubmit()) {
        blurMobileComposerAfterSend();
      }
    };
    const submitComposerStable = useStableCallback(submitComposer);
    const handleSubmitMessage = (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      submitComposer(
        event,
        resolveComposerDispatchMode({
          running: phase === "running",
          alternateModifier: event.metaKey || event.ctrlKey,
          activeTurnDefault: followUpBehavior,
          canSteer: !isCompacting,
        }),
      );
    };
    const handleSubmitMessageStable = useStableCallback(handleSubmitMessage);
    const submitCitationAndSend = () => {
      submitComposer(
        undefined,
        resolveComposerDispatchMode({
          running: phase === "running",
          alternateModifier: false,
          activeTurnDefault: followUpBehavior,
          canSteer: !isCompacting,
        }),
      );
    };
    const submitCitationAndSendStable = useStableCallback(submitCitationAndSend);
    // A question took the editor while a citation comment was
    // unsaved. Keep the comment in the prompt that comes back afterward.
    const saveCitationDraftToPrompt = (replacedValue: string, savedValue: string) => {
      if (replacedValue !== prompt) return;
      if (promptRef.current === replacedValue) promptRef.current = savedValue;
      setPrompt(savedValue);
    };
    const saveCitationDraftToPromptStable = useStableCallback(saveCitationDraftToPrompt);
    const compactThreadContext = () => {
      if (
        !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
        compactDisabled ||
        noProviderAvailable ||
        activePendingApproval !== null ||
        pendingUserInputs.length > 0 ||
        phase === "running" ||
        isSendBusy ||
        !activeThreadId
      ) {
        return;
      }
      onCompactContext();
    };
    const compactThreadContextStable = useStableCallback(compactThreadContext);
    const expandMobileComposer = () => {
      if (composerBlurFrameRef.current !== null) {
        window.cancelAnimationFrame(composerBlurFrameRef.current);
        composerBlurFrameRef.current = null;
      }
      if (mobileComposerExpandFrameRef.current !== null) {
        window.cancelAnimationFrame(mobileComposerExpandFrameRef.current);
      }
      if (mobileComposerExpandReleaseFrameRef.current !== null) {
        window.cancelAnimationFrame(mobileComposerExpandReleaseFrameRef.current);
      }
      mobileComposerExpandInFlightRef.current = true;
      setIsComposerFocused(true);
      mobileComposerExpandFrameRef.current = window.requestAnimationFrame(() => {
        mobileComposerExpandFrameRef.current = null;
        composerEditorRef.current?.focusAtEnd();
        mobileComposerExpandReleaseFrameRef.current = window.requestAnimationFrame(() => {
          mobileComposerExpandReleaseFrameRef.current = null;
          mobileComposerExpandInFlightRef.current = false;
        });
      });
    };
    const expandMobileComposerStable = useStableCallback(expandMobileComposer);

    const onComposerCommandKey = (key: string, event: KeyboardEvent, isTaskItem?: boolean) =>
      composerCommandKeyHandler({
        keybindings,
        sendShortcut: settings.sendShortcut,
        routeKind,
        phase,
        isCompacting,
        followUpBehavior,
        isSoftwareKeyboardOpen,
        planModeUiEnabled,
        isLiteralPendingAnswer,
        pendingUserInputs,
        promptHistoryEntries,
        promptHistoryPositionRef,
        composerDraftTarget,
        promptRef,
        composerImagesRef,
        composerFilesRef,
        composerTerminalContextsRef,
        composerPreviewAnnotations,
        composerReviewComments,
        composerEditorRef,
        composerMenuOpenRef,
        composerMenuItemsRef,
        activeComposerMenuItemRef,
        setComposerDraftPrompt,
        setComposerCursor,
        setComposerTrigger,
        setComposerHighlightedItemId,
        dismissComposerTrigger,
        toggleInteractionMode,
        nudgeComposerMenuHighlight,
        onSelectComposerItem,
        resolveActiveComposerTrigger,
        readComposerSnapshot,
        applyPromptReplacement,
        submitComposer,
      })(key, event, isTaskItem);

  return { onSelectComposerItemStable, onComposerMenuItemHighlightedStable, submitComposer, submitComposerStable, handleSubmitMessageStable, submitCitationAndSendStable, saveCitationDraftToPromptStable, compactThreadContextStable, expandMobileComposer, expandMobileComposerStable, onComposerCommandKey };
}
