import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { resolveComposerDispatchMode } from "@t3tools/client-runtime/state/composer-dispatch";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadSupportsProviderHandoff } from "@t3tools/client-runtime/state/thread-workflows";
import {
  type AssistantCitation,
  AuthOrchestrationOperateScope,
  type OrchestrationV2SideChatOpening,
  type ScopedThreadRef,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { ArrowUpIcon, PaperclipIcon } from "lucide-react";
import { useImperativeHandle, useRef, useState } from "react";

import {
  collapseExpandedComposerCursor,
  composerSubmissionIntentForKey,
  formatAssistantCitationForComposer,
  replaceTextRange,
} from "../../composer-logic";
import {
  useComposerDraftModelState,
  useComposerDraftStore,
  useComposerThreadDraft,
} from "../../composerDraftStore";
import {
  countPreparingComposerImages,
  usePreparingComposerImages,
} from "../chat/preparingComposerImages";
import { useComposerAttachmentIntake } from "../chat/useComposerAttachmentIntake";
import { ComposerAttachmentMediaRow } from "../chat/ComposerAttachmentStrip";
import {
  classifyComposerAttachmentFile,
  shouldHandleComposerAttachmentPaste,
} from "../chat/composerAttachmentFiles";
import { prepareTurnAttachments, restoreComposerDraft } from "../chat/chatViewSend";
import { optimisticMessageAttachments, snapshotComposerSend } from "../ChatView.logic";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../../state/server";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  readAttachmentUpload,
  releaseAttachmentUpload,
  releaseDraftAttachments,
  retryAttachmentUpload,
  startAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useSoftwareKeyboardOpen } from "../../hooks/useSoftwareKeyboardOpen";
import type { AssistantCitationSourceAnchor } from "../../lib/assistantTextSelection";
import { isMacPlatform, newMessageId } from "../../lib/utils";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { makeModelDisabledReason } from "../ChatView.logic";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { useEnvironmentProviders } from "../../state/environments";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import {
  ORCHESTRATION_OPERATE_DENIED_MESSAGE,
  useOrchestrationCommand,
} from "../../state/use-orchestration-command";
import type { ChatMessage } from "../../types";
import { draftSendState } from "../chat/chatViewSend";
import { ComposerPromptLengthValidation } from "../chat/ComposerPromptLengthValidation";
import { planSideChatSend, type SideChatSendPlan } from "../chat/composerSend.logic";
import { EMPTY_COMPOSER_CONTEXT_RECORDS } from "../composerContextPresentation";
import {
  type ComposerPromptEditorHandle,
  ComposerPromptEditorTiptap as ComposerPromptEditor,
} from "../ComposerPromptEditorTiptap";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { appendComposerSnippet, sideChatComposerStatus } from "./sideChatPanel.logic";
import { alternateComposerDispatchAction } from "@t3tools/client-runtime/state/composer-dispatch";

export interface SideChatComposerHandle {
  readonly focusAtEnd: () => void;
  readonly insertTextAtEnd: (text: string) => boolean;
  readonly citeAssistantText: (
    citation: AssistantCitation,
    sourceAnchor: AssistantCitationSourceAnchor,
  ) => boolean;
}

const NO_SKILLS: ReadonlyArray<ServerProviderSkill> = [];

function sendBlockedDescription(plan: SideChatSendPlan): string | undefined {
  if (plan._tag !== "Blocked") return undefined;
  switch (plan.reason) {
    case "starting":
      return "Starting side chat…";
    case "antigravity-unavailable":
      return plan.message;
    case "provider-unavailable":
      return "This side chat's provider is unavailable";
    case "no-operate-scope":
      return ORCHESTRATION_OPERATE_DENIED_MESSAGE;
    case "in-flight":
    case "empty":
      return undefined;
  }
}

/**
 * The side chat's compact composer supports text, image attachments, queueing, steering, stopping,
 * and choosing the side chat's model. It keeps lesson-only controls out of the narrow panel.
 */
export function SideChatComposer(props: {
  readonly sideChatRef: ScopedThreadRef;
  /** Null while the side chat is starting. */
  readonly shell: EnvironmentThreadShell | null;
  /** The environment's providers have loaded, so a missing entry means the provider is gone. */
  readonly providerCatalogKnown: boolean;
  readonly projection?: Parameters<typeof threadSupportsProviderHandoff>[0];
  readonly openingStatus: OrchestrationV2SideChatOpening["status"] | null;
  /** The side chat has a message, so the next one is a follow-up rather than its question. */
  readonly hasMessages: boolean;
  readonly runActive: boolean;
  readonly turnRunning: boolean;
  readonly pendingApprovalCount: number;
  readonly canInterrupt: boolean;
  readonly sendQueuesBehindSetup: boolean;
  readonly answeringPendingUserInput: boolean;
  readonly onExpandImage: (preview: ExpandedImagePreview) => void;
  readonly handleRef: React.RefObject<SideChatComposerHandle | null>;
  readonly onAdvancePendingUserInput: () => void;
  /** The pending question's custom answer, shown in the editor while answering. */
  readonly pendingUserInputCustomAnswer?: string | undefined;
  readonly onPendingUserInputCustomAnswerChange?:
    | ((value: string, cursor: number) => void)
    | undefined;
  readonly onOptimisticMessage: (message: ChatMessage) => void;
  readonly onOptimisticMessageFailed: (message: ChatMessage) => void;
  readonly onPageScrollKeyDown: (key: "PageUp" | "PageDown") => void;
  readonly onPageScrollKeyUp: (key: string) => void;
  readonly onPageScrollRelease: () => void;
}) {
  const { sideChatRef, shell, answeringPendingUserInput } = props;
  const turnRunning = props.turnRunning;
  const settings = useEnvironmentSettings(sideChatRef.environmentId, (value) => value);
  const providers = useEnvironmentProviders().get(sideChatRef.environmentId) ?? [];
  const draftModel = useComposerDraftModelState(sideChatRef);
  const explicitSelection = draftModel.activeProvider
    ? draftModel.modelSelectionByProvider[draftModel.activeProvider]
    : undefined;
  const modelSelection = explicitSelection ?? shell?.modelSelection;
  const instanceEntries = providerInstanceEntriesFor(providers, settings, shell?.projectId ?? null);
  const selectedProviderEntry = modelSelection
    ? instanceEntries.find((entry) => entry.instanceId === modelSelection.instanceId)
    : undefined;
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    modelSelection?.instanceId,
    modelSelection?.model,
  );
  const sideChatKey = scopedThreadKey(sideChatRef);
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const draft = useComposerThreadDraft(sideChatRef);
  const draftPrompt = draft.prompt;
  const preparingImages = usePreparingComposerImages(sideChatKey);
  const promptRef = useRef(draftPrompt);
  const composerImagesRef = useRef(draft.images);
  const composerFilesRef = useRef(draft.files);
  const uploadsSupported = appAtomRegistry
    .get(environmentServerConfigsAtom)
    .has(sideChatRef.environmentId);
  const setThreadError = (_threadId: string | null, error: string | null) => {
    if (error !== null) toastManager.add(stackedThreadToast({ type: "error", title: error }));
  };
  const startUploads = (images: (typeof draft.images)[number][]) => {
    if (!uploadsSupported) return;
    for (const image of images) {
      startAttachmentUpload({
        environmentId: sideChatRef.environmentId,
        image,
        draftTarget: sideChatRef,
      });
    }
  };
  const addComposerImage = (image: (typeof draft.images)[number]) => {
    if (!useComposerDraftStore.getState().addImage(sideChatRef, image)) return [];
    startUploads([image]);
    return [image.id];
  };
  const addComposerImagesToDraft = (images: (typeof draft.images)[number][]) => {
    const ids = useComposerDraftStore.getState().addImages(sideChatRef, images);
    startUploads(images.filter((image) => ids.includes(image.id)));
    return ids;
  };
  const removeComposerImageFromDraft = (imageId: string) => {
    releaseAttachmentUpload(imageId);
    useComposerDraftStore.getState().removeImage(sideChatRef, imageId);
  };
  const intake = useComposerAttachmentIntake({
    activeThreadId: sideChatRef.threadId,
    activePendingProgress: null,
    activePendingIsResponding: false,
    pendingUserInputs: [],
    supportsQuestionAttachments: false,
    isLiteralPendingAnswer: false,
    projectSelectionRequired: false,
    questionAttachmentTarget: null,
    attachmentTargetKey: sideChatKey,
    fileStagingLimit: null,
    promptRef,
    composerImagesRef,
    composerFilesRef,
    composerEditorRef: editorRef,
    isRevertingCheckpointRef: useRef(false),
    setThreadError,
    countReservedAttachments: () => draft.images.length + countPreparingComposerImages(sideChatKey),
    addComposerImage,
    addComposerImagesToDraft,
    addComposerFilesToDraft: () => [],
    removeComposerImageFromDraft,
    insertAttachmentReferences: () => false,
  });
  const addImages = (files: File[]) => {
    const current = useComposerDraftStore.getState().getComposerDraft(sideChatRef);
    promptRef.current = current?.prompt ?? "";
    composerImagesRef.current = current?.images ?? [];
    composerFilesRef.current = current?.files ?? [];
    const allowed = files.filter((file) => classifyComposerAttachmentFile(file) !== "file");
    if (allowed.length !== files.length) {
      toastManager.add({ type: "error", title: "Side chats can only attach images." });
    }
    if (answeringPendingUserInput) {
      if (allowed.length > 0)
        toastManager.add({ type: "error", title: "This question cannot accept attachments." });
      return Promise.resolve(false);
    }
    if (allowed.length === 0) return Promise.resolve(false);
    return intake.addComposerAttachments(allowed, { skipImageInlineChip: true });
  };
  // While a question is pending the editor holds its answer, apart from the side chat's draft.
  const answer = answeringPendingUserInput ? (props.pendingUserInputCustomAnswer ?? "") : null;
  const prompt = answer ?? draftPrompt;
  // The editor's caret, kept per side chat and per text so a new one opens at its end.
  const caretKey = answer === null ? sideChatKey : `${sideChatKey}:answer`;
  const [caret, setCaret] = useState<{ readonly key: string; readonly cursor: number } | null>(
    null,
  );
  const cursor =
    caret?.key === caretKey ? caret.cursor : collapseExpandedComposerCursor(prompt, prompt.length);
  // The send-state ref dedupes across remounts; this state re-renders the button.
  const [sending, setSending] = useState(false);
  const canOperate = useEnvironmentScope(sideChatRef.environmentId, AuthOrchestrationOperateScope);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const sendShortcut = useEnvironmentSettings(
    sideChatRef.environmentId,
    (settings) => settings.sendShortcut,
  );
  const followUpBehavior = useEnvironmentSettings(
    sideChatRef.environmentId,
    (settings) => settings.followUpBehavior,
  );
  const isSoftwareKeyboardOpen = useSoftwareKeyboardOpen();
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const interruptTurn = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });

  const readDraft = () =>
    useComposerDraftStore.getState().getComposerDraft(sideChatRef)?.prompt ?? "";
  const writeDraft = (next: string, expandedCursor: number) => {
    useComposerDraftStore.getState().setPrompt(sideChatRef, next);
    setCaret({ key: sideChatKey, cursor: collapseExpandedComposerCursor(next, expandedCursor) });
  };
  // The editor's text: the pending answer while answering, the side chat's draft otherwise.
  const readPrompt = () => answer ?? readDraft();
  const writePrompt = (next: string, expandedCursor: number) => {
    if (answer === null) {
      writeDraft(next, expandedCursor);
      return;
    }
    const nextCursor = collapseExpandedComposerCursor(next, expandedCursor);
    props.onPendingUserInputCustomAnswerChange?.(next, nextCursor);
    setCaret({ key: caretKey, cursor: nextCursor });
  };
  const planSend = (input: { readonly sendInFlight: boolean; readonly prompt: string }) =>
    planSideChatSend({
      canOperate,
      sendInFlight: input.sendInFlight,
      shellReady: shell !== null,
      answeringPendingUserInput,
      providerEntry: selectedProviderEntry,
      model: modelSelection?.model ?? "",
      attachmentCount:
        (useComposerDraftStore.getState().getComposerDraft(sideChatRef)?.images.length ?? 0) +
        countPreparingComposerImages(sideChatKey),
      prompt: input.prompt,
    });

  const send = async (alternateModifier = false) => {
    const { sendInFlight } = draftSendState(sideChatKey);
    const text = readDraft();
    const plan = planSend({ sendInFlight: sendInFlight.current, prompt: text });
    if (plan._tag === "AnswerPendingInput") {
      props.onAdvancePendingUserInput();
      return;
    }
    if (plan._tag !== "Ready" || shell === null) return;
    if (preparingImages.length > 0) {
      toastManager.add({ type: "error", title: "Wait for the image to finish preparing." });
      return;
    }
    const draftSnapshot = useComposerDraftStore.getState().getComposerDraft(sideChatRef);
    const images = draftSnapshot?.images ?? [];
    const files = draftSnapshot?.files ?? [];
    const sendSnapshot = snapshotComposerSend({
      prompt: text,
      images,
      files,
      terminalContexts: [],
      sendableTerminalContexts: [],
      previewAnnotations: [],
      reviewComments: [],
      threadContexts: [],
      environmentContexts: [],
    });
    const dispatchMode = props.sendQueuesBehindSetup
      ? "queue"
      : resolveComposerDispatchMode({
          running: turnRunning,
          alternateModifier,
          activeTurnDefault: followUpBehavior,
          canSteer: props.pendingApprovalCount === 0,
        });

    sendInFlight.current = true;
    setSending(true);
    const messageId = newMessageId();
    // oxlint-disable-next-line react/purity -- dispatch payloads need the creation timestamp
    const createdAt = new Date().toISOString();
    const optimisticMessage: ChatMessage = {
      id: messageId,
      role: "user",
      ...plan.message,
      ...(images.length + files.length > 0
        ? { attachments: optimisticMessageAttachments([...images, ...files]) }
        : {}),
      runId: null,
      streaming: false,
      createdAt,
      updatedAt: createdAt,
      ...(dispatchMode === "queue" ? { inputIntent: "queued_turn" as const } : {}),
      ...(dispatchMode === "steer" ? { inputIntent: "steer" as const } : {}),
    };
    if (uploadsSupported && images.length > 0) {
      for (const image of images) {
        const upload =
          readAttachmentUpload(image.id)?.status === "failed"
            ? retryAttachmentUpload
            : startAttachmentUpload;
        upload({ environmentId: sideChatRef.environmentId, image, draftTarget: sideChatRef });
      }
      await awaitAttachmentUploads(images.map((image) => image.id));
      if (getUploadedAttachments({ environmentId: sideChatRef.environmentId, images }) === null) {
        sendInFlight.current = false;
        setSending(false);
        toastManager.add({
          type: "error",
          title: "Retry or remove failed uploads before sending.",
        });
        return;
      }
    }
    props.onOptimisticMessage(optimisticMessage);
    useComposerDraftStore.getState().clearComposerContent(sideChatRef);
    let attachments: Awaited<ReturnType<typeof prepareTurnAttachments>> = [];
    try {
      attachments = await prepareTurnAttachments({
        environmentId: sideChatRef.environmentId,
        attachments: [...images, ...files],
        usesAttachmentUploads: uploadsSupported,
      });
    } catch (error) {
      props.onOptimisticMessageFailed(optimisticMessage);
      restoreComposerDraft(sideChatRef, sendSnapshot);
      sendInFlight.current = false;
      setSending(false);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Couldn't prepare the image",
          description: error instanceof Error ? error.message : undefined,
        }),
      );
      return;
    }
    const result = await startTurn({
      environmentId: sideChatRef.environmentId,
      input: {
        threadId: sideChatRef.threadId,
        message: { messageId, role: "user", attachments, ...plan.message },
        modelSelection: modelSelection ?? shell.modelSelection,
        dispatchMode:
          dispatchMode === "queue" ? "queue" : dispatchMode === "steer" ? "steer" : "start",
        runtimeMode: shell.runtimeMode,
        interactionMode: shell.interactionMode,
        createdAt,
      },
    });
    sendInFlight.current = false;
    setSending(false);
    if (result._tag === "Success") {
      if (uploadsSupported) releaseDraftAttachments(images);
      return;
    }

    props.onOptimisticMessageFailed(optimisticMessage);
    // Text typed while the send was in flight stays; the failed row still shows the message.
    if (readDraft() === "") restoreComposerDraft(sideChatRef, sendSnapshot);
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Couldn't send to the side chat",
        description: error instanceof Error ? error.message : undefined,
      }),
    );
  };

  useImperativeHandle(props.handleRef, () => ({
    focusAtEnd: () => editorRef.current?.focusAtEnd(),
    insertTextAtEnd: (text) => {
      if (text === "") return false;
      const next = `${readPrompt()}${text}`;
      writePrompt(next, next.length);
      // The new value lands on the next render, which moves the caret to its end.
      editorRef.current?.focus();
      return true;
    },
    citeAssistantText: (citation, sourceAnchor) => {
      const editor = editorRef.current;
      if (!editor) return false;
      const current = readPrompt();
      const snippet = formatAssistantCitationForComposer(citation, citation.comment);
      const next = appendComposerSnippet(current, snippet);
      const citationStart = next.length - snippet.length;
      editor.requestCitationComment({
        previousValue: current,
        value: next,
        citationStart,
        sourceAnchor,
        insertedSpaces: { before: citationStart > current.length, after: true },
      });
      writePrompt(next, next.length);
      return true;
    },
  }));

  const hasSendableContent =
    prompt.trim() !== "" || (answer === null && draft.images.length + preparingImages.length > 0);
  const showStop = props.canInterrupt && !answeringPendingUserInput && !hasSendableContent;
  const stop = async () => {
    if (!showStop || !canOperate) return;
    const result = await interruptTurn({
      environmentId: sideChatRef.environmentId,
      input: { threadId: sideChatRef.threadId },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Couldn't stop the side chat",
          description: error instanceof Error ? error.message : undefined,
        }),
      );
    }
  };

  const plan = planSend({ sendInFlight: sending, prompt });
  const status = sideChatComposerStatus({
    shellExists: shell !== null,
    openingStatus: props.openingStatus,
    runActive: props.runActive,
    providerUnavailable:
      !props.providerCatalogKnown ||
      plan._tag !== "Blocked" ||
      plan.reason !== "provider-unavailable"
        ? null
        : selectedProviderEntry === undefined
          ? "missing"
          : "unavailable",
    blockedReason:
      plan._tag === "Blocked" && plan.reason === "antigravity-unavailable"
        ? (plan.message ?? null)
        : null,
  });
  const answerLabel = "Submit answer";
  const blockedReason = sendBlockedDescription(plan);
  const clickDispatchMode = resolveComposerDispatchMode({
    running: turnRunning,
    alternateModifier: false,
    activeTurnDefault: followUpBehavior,
    canSteer: props.pendingApprovalCount === 0,
  });
  const sendTip = showStop
    ? "Stop"
    : answeringPendingUserInput
      ? answerLabel
      : (blockedReason ??
        (plan._tag === "Invalid"
          ? plan.message
          : turnRunning
            ? props.pendingApprovalCount > 0
              ? "Queue message"
              : `Click to ${followUpBehavior}, ${isMacPlatform(navigator.platform) ? "⌘" : "Ctrl"}-click to ${alternateComposerDispatchAction(followUpBehavior)}`
            : "Send"));

  return (
    <div
      className="border-t border-border"
      onDragOver={(event) => {
        if ([...event.dataTransfer.items].some((item) => item.type.startsWith("image/"))) {
          event.preventDefault();
        }
      }}
      onDrop={(event) => {
        const files = [...event.dataTransfer.files];
        if (files.length > 0) {
          event.preventDefault();
          void addImages(files);
        }
      }}
    >
      {/* Empty but never display:none: a hidden live region drops out of the accessibility tree, so a line that appears in it may go unannounced. */}
      <p role="status" className="px-3 pt-2 text-muted-foreground text-xs empty:pt-0">
        {status}
      </p>
      {draft.images.length > 0 || preparingImages.length > 0 ? (
        <div className="px-3 pt-2">
          <ComposerAttachmentMediaRow
            images={draft.images}
            expandedImages={draft.images}
            preparingImages={preparingImages}
            videos={[]}
            pendingSnapShotAnimations={[]}
            pendingSnapShotIds={[]}
            uncommittedSnapShotIds={[]}
            nonPersistedImageIds={draft.nonPersistedImageIds}
            snapShotAnimations={false}
            supportsAttachmentUploads={uploadsSupported}
            maxFileAttachmentBytes={null}
            environmentId={sideChatRef.environmentId}
            attachmentDraftTarget={sideChatRef}
            canOperateThread={canOperate}
            onExpandImage={props.onExpandImage}
            onFileOpen={() => {}}
            onRemoveImage={intake.removeComposerImage}
            onRemoveFile={() => {}}
          />
        </div>
      ) : null}
      <div className="flex items-end gap-2 px-3 py-2">
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Attach images"
              onClick={() => document.getElementById(`side-chat-images-${sideChatKey}`)?.click()}
            >
              <PaperclipIcon aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipPopup>Attach images</TooltipPopup>
        </Tooltip>
        <input
          id={`side-chat-images-${sideChatKey}`}
          className="hidden"
          type="file"
          accept="image/*"
          multiple
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.currentTarget.value = "";
            void addImages(files);
          }}
        />
        <ComposerPromptEditor
          draftKey={sideChatKey}
          ariaLabel="Side chat message"
          placeholder={props.hasMessages ? "Ask a follow-up…" : "Ask your own question…"}
          editorRef={editorRef}
          value={prompt}
          cursor={cursor}
          contextRecords={EMPTY_COMPOSER_CONTEXT_RECORDS}
          skills={NO_SKILLS}
          disabled={false}
          containerClassName="min-w-24 flex-1"
          className="min-h-10"
          onChange={(value, nextCursor) => {
            if (answer === null) useComposerDraftStore.getState().setPrompt(sideChatRef, value);
            else props.onPendingUserInputCustomAnswerChange?.(value, nextCursor);
            setCaret({ key: caretKey, cursor: nextCursor });
          }}
          onCommandKeyDown={(key, event) => {
            if (key !== "Enter") return false;
            const intent = composerSubmissionIntentForKey({
              event,
              keybindings,
              isSoftwareKeyboardOpen,
              isDraftThread: false,
              isRunning: turnRunning,
              sendShortcut,
              prompt,
            });
            if (intent === null) return false;
            if (intent === "foreground") void send(false);
            else if (intent === "alternate") void send(true);
            return true;
          }}
          onPageScrollKeyDown={props.onPageScrollKeyDown}
          onPageScrollKeyUp={props.onPageScrollKeyUp}
          onPageScrollRelease={props.onPageScrollRelease}
          onCitationSubmitAndSend={() => void send()}
          onPaste={(event) => {
            const files = [...event.clipboardData.files];
            if (
              files.length > 0 &&
              shouldHandleComposerAttachmentPaste({
                files,
                plainText: event.clipboardData.getData("text/plain"),
              })
            ) {
              event.preventDefault();
              void addImages(files);
              return;
            }
            // The editor leaves a clipboard holding files to the browser, so paste its text here and drop the non-image files.
            if (event.clipboardData.files.length === 0) return;
            event.preventDefault();
            const text = event.clipboardData.getData("text/plain");
            const selection = editorRef.current?.readSelectionRange();
            if (text === "" || !selection) return;
            const next = replaceTextRange(readPrompt(), selection.start, selection.end, text);
            writePrompt(next.text, next.cursor);
          }}
        />
        {shell !== null && modelSelection !== undefined ? (
          <ProviderModelPicker
            environmentId={sideChatRef.environmentId}
            activeInstanceId={modelSelection.instanceId}
            model={modelSelection.model}
            lockedProvider={
              threadSupportsProviderHandoff(props.projection ?? null)
                ? null
                : (selectedProviderEntry?.driverKind ?? null)
            }
            instanceEntries={instanceEntries}
            modelOptionsByInstance={modelOptionsByInstance}
            compact
            size="sm"
            triggerClassName="shrink"
            triggerAriaLabel="Choose side chat model"
            getModelDisabledReason={makeModelDisabledReason(null)}
            onInstanceModelChange={(instanceId, model) => {
              const store = useComposerDraftStore.getState();
              const current = shell.modelSelection;
              const options =
                current?.instanceId === instanceId && current.model === model
                  ? current.options
                  : store.stickyOptionsByModelByProvider[instanceId]?.[model];
              store.setModelSelection(
                sideChatRef,
                createModelSelection(instanceId, model, options),
                {
                  explicit: true,
                  replaceOptions: true,
                },
              );
            }}
          />
        ) : null}
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>
            <Button
              size="icon-sm"
              disabled={showStop ? !canOperate : plan._tag === "Blocked" || plan._tag === "Invalid"}
              onClick={(event) =>
                showStop ? void stop() : void send(event.metaKey || event.ctrlKey)
              }
              aria-label={
                showStop
                  ? "Stop"
                  : answeringPendingUserInput
                    ? answerLabel
                    : turnRunning
                      ? clickDispatchMode === "queue"
                        ? "Queue message"
                        : "Steer message"
                      : "Send side chat message"
              }
              aria-description={
                showStop
                  ? canOperate
                    ? undefined
                    : ORCHESTRATION_OPERATE_DENIED_MESSAGE
                  : blockedReason
              }
            >
              {showStop ? (
                <span className="size-3 rounded-xs bg-current" aria-hidden="true" />
              ) : (
                <ArrowUpIcon aria-hidden="true" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipPopup>{sendTip}</TooltipPopup>
        </Tooltip>
      </div>
      <ComposerPromptLengthValidation message={plan._tag === "Invalid" ? plan.message : null} />
    </div>
  );
}
