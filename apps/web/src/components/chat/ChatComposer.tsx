import {
  type ApprovalRequestId,
  type CodexReasoningEffort,
  type ModelSlug,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ProviderApprovalDecision,
  type ProviderKind,
  type ThreadId,
  RuntimeMode,
  ProviderInteractionMode,
} from "@t3tools/contracts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ComposerTriggerKind } from "../../composer-logic";
import {
  PendingApproval,
  PendingUserInput,
  LatestProposedPlanState,
  ActivePlanState,
} from "../../session-logic";
import { PendingUserInputProgress, type PendingUserInputDraftAnswer } from "../../pendingUserInput";
import { proposedPlanTitle } from "../../proposedPlan";
import { SessionPhase } from "../../types";
import {
  BotIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  ListTodoIcon,
  LockIcon,
  LockOpenIcon,
  XIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { Separator } from "../ui/separator";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { cn, randomUUID } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { type ComposerImageAttachment, useComposerDraftStore } from "../../composerDraftStore";
import { shouldUseCompactComposerFooter } from "../composerFooterLayout";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { ComposerCommandItem, ComposerCommandMenu } from "./ComposerCommandMenu";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { CodexTraitsPicker } from "./CodexTraitsPicker";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { ComposerPlanFollowUpBanner } from "./ComposerPlanFollowUpBanner";

const IMAGE_SIZE_LIMIT_LABEL = `${Math.round(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / (1024 * 1024))}MB`;

interface ChatComposerProps {
  // Context / refs
  threadId: ThreadId;
  activeThreadId: ThreadId;
  resolvedTheme: "light" | "dark";
  composerEditorRef: React.RefObject<ComposerPromptEditorHandle | null>;
  composerImagesRef: React.RefObject<ComposerImageAttachment[]>;
  shouldAutoScrollRef: React.RefObject<boolean>;
  scheduleStickToBottom: () => void;

  // Core composer state
  prompt: string;
  composerCursor: number;
  composerImages: ComposerImageAttachment[];
  nonPersistedComposerImageIdSet: Set<string>;
  setExpandedImage: React.Dispatch<React.SetStateAction<ExpandedImagePreview | null>>;
  phase: SessionPhase;

  // Pending workflow state
  pendingApprovals: PendingApproval[];
  activePendingApproval: PendingApproval | null;
  pendingUserInputs: PendingUserInput[];
  activePendingDraftAnswers: Record<string, PendingUserInputDraftAnswer>;
  activePendingQuestionIndex: number;
  activePendingProgress: PendingUserInputProgress | null;
  activePendingResolvedAnswers: Record<string, string> | null;
  activeProposedPlan: LatestProposedPlanState | null;
  activePlan: ActivePlanState | null;
  respondingUserInputRequestIds: ApprovalRequestId[];
  respondingRequestIds: ApprovalRequestId[];

  // Composer menu state
  composerMenuItems: ComposerCommandItem[];
  composerTriggerKind: ComposerTriggerKind | null;
  activeComposerMenuItem: ComposerCommandItem | null;

  // Provider / runtime state
  selectedProvider: ProviderKind;
  selectedModelForPickerWithCustomFallback: ModelSlug;
  lockedProvider: ProviderKind | null;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>>;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  selectedEffort: CodexReasoningEffort;
  reasoningOptions: ReadonlyArray<CodexReasoningEffort>;

  // Event handlers
  onPromptChange: (
    nextPrompt: string,
    nextCursor: number,
    cursorAdjacentToMention: boolean,
  ) => void;
  onComposerCommandKey: (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab",
    event: KeyboardEvent,
  ) => boolean;
  onComposerMenuItemHighlighted: (itemId: string | null) => void;
  onSelectComposerItem: (item: ComposerCommandItem) => void;
  onProviderModelSelect: (provider: ProviderKind, model: ModelSlug) => void;
  onEffortSelect: (effort: CodexReasoningEffort) => void;
  onCodexFastModeChange: (enabled: boolean) => void;
  onSelectActivePendingUserInputOption: (questionId: string, optionLabel: string) => void;
  onAdvanceActivePendingUserInput: () => void;
  onPreviousActivePendingUserInputQuestion: () => void;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
  onInterrupt: () => void;
  onSend: () => void;
  onImplementPlanInNewThread: () => void;
  toggleInteractionMode: () => void;
  toggleRuntimeMode: () => void;
  togglePlanSidebar: () => void;
  handleRuntimeModeChange: (mode: RuntimeMode) => void;
  focusComposer: () => void;
  setThreadError: (targetThreadId: ThreadId | null, error: string | null) => void;
  addComposerImagesToDraft: (images: ComposerImageAttachment[]) => void;

  // UI flags
  flags: {
    activePendingIsResponding: boolean;
    showPlanFollowUpPrompt: boolean;
    isComposerApprovalState: boolean;
    hasComposerHeader: boolean;
    composerMenuOpen: boolean;
    isComposerMenuLoading: boolean;
    isSendBusy: boolean;
    isConnecting: boolean;
    isPreparingWorktree: boolean;
    planSidebarOpen: boolean;
    selectedCodexFastModeEnabled: boolean;
    composerFooterHasWideActions: boolean;
    isGitRepo: boolean;
  };
}

export function ChatComposer({
  threadId,
  activeThreadId,
  resolvedTheme,
  composerEditorRef,
  composerImagesRef,
  shouldAutoScrollRef,
  scheduleStickToBottom,
  prompt,
  composerCursor,
  composerImages,
  nonPersistedComposerImageIdSet,
  setExpandedImage,
  phase,
  pendingApprovals,
  activePendingApproval,
  pendingUserInputs,
  activePendingDraftAnswers,
  activePendingQuestionIndex,
  activePendingProgress,
  activePendingResolvedAnswers,
  activeProposedPlan,
  activePlan,
  respondingUserInputRequestIds,
  respondingRequestIds,
  composerMenuItems,
  composerTriggerKind,
  activeComposerMenuItem,
  selectedProvider,
  selectedModelForPickerWithCustomFallback,
  lockedProvider,
  modelOptionsByProvider,
  runtimeMode,
  interactionMode,
  selectedEffort,
  reasoningOptions,
  onPromptChange,
  onComposerCommandKey,
  onComposerMenuItemHighlighted,
  onSelectComposerItem,
  onProviderModelSelect,
  onEffortSelect,
  onCodexFastModeChange,
  onSelectActivePendingUserInputOption,
  onAdvanceActivePendingUserInput,
  onPreviousActivePendingUserInputQuestion,
  onRespondToApproval,
  onInterrupt,
  onSend,
  onImplementPlanInNewThread,
  toggleInteractionMode,
  toggleRuntimeMode,
  togglePlanSidebar,
  handleRuntimeModeChange,
  focusComposer,
  setThreadError,
  addComposerImagesToDraft,
  flags: {
    activePendingIsResponding,
    showPlanFollowUpPrompt,
    isComposerApprovalState,
    hasComposerHeader,
    composerMenuOpen,
    isComposerMenuLoading,
    isSendBusy,
    isConnecting,
    isPreparingWorktree,
    planSidebarOpen,
    selectedCodexFastModeEnabled,
    composerFooterHasWideActions,
    isGitRepo,
  },
}: ChatComposerProps) {
  const composerFormRef = useRef<HTMLFormElement>(null);
  const composerFormHeightRef = useRef(0);
  const dragDepthRef = useRef(0);

  const [isDragOverComposer, setIsDragOverComposer] = useState(false);
  const [isComposerFooterCompact, setIsComposerFooterCompact] = useState(false);

  useEffect(() => {
    dragDepthRef.current = 0;
    setIsDragOverComposer(false);
  }, [threadId]);

  useLayoutEffect(() => {
    const composerForm = composerFormRef.current;
    if (!composerForm) return;
    const measureComposerFormWidth = () => composerForm.clientWidth;

    composerFormHeightRef.current = composerForm.getBoundingClientRect().height;
    setIsComposerFooterCompact(
      shouldUseCompactComposerFooter(measureComposerFormWidth(), {
        hasWideActions: composerFooterHasWideActions,
      }),
    );
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const [entry] = entries;
      if (!entry) return;

      const nextCompact = shouldUseCompactComposerFooter(measureComposerFormWidth(), {
        hasWideActions: composerFooterHasWideActions,
      });
      setIsComposerFooterCompact((previous) => (previous === nextCompact ? previous : nextCompact));

      const nextHeight = entry.contentRect.height;
      const previousHeight = composerFormHeightRef.current;
      composerFormHeightRef.current = nextHeight;

      if (previousHeight > 0 && Math.abs(nextHeight - previousHeight) < 0.5) return;
      if (!shouldAutoScrollRef.current) return;
      scheduleStickToBottom();
    });

    observer.observe(composerForm);
    return () => {
      observer.disconnect();
    };
  }, [activeThreadId, composerFooterHasWideActions, scheduleStickToBottom]);

  const addComposerDraftImage = useComposerDraftStore((store) => store.addImage);
  const removeComposerDraftImage = useComposerDraftStore((store) => store.removeImage);

  const addComposerImage = useCallback(
    (image: ComposerImageAttachment) => {
      addComposerDraftImage(threadId, image);
    },
    [addComposerDraftImage, threadId],
  );

  const removeComposerImageFromDraft = useCallback(
    (imageId: string) => {
      removeComposerDraftImage(threadId, imageId);
    },
    [removeComposerDraftImage, threadId],
  );

  const addComposerImages = (files: File[]) => {
    if (!activeThreadId || files.length === 0) return;

    const nextImages: ComposerImageAttachment[] = [];
    let nextImageCount = composerImagesRef.current.length;
    let error: string | null = null;
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        error = `Unsupported file type for '${file.name}'. Please attach image files only.`;
        continue;
      }
      if (file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
        error = `'${file.name}' exceeds the ${IMAGE_SIZE_LIMIT_LABEL} attachment limit.`;
        continue;
      }
      if (nextImageCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images per message.`;
        break;
      }

      const previewUrl = URL.createObjectURL(file);
      nextImages.push({
        type: "image",
        id: randomUUID(),
        name: file.name || "image",
        mimeType: file.type,
        sizeBytes: file.size,
        previewUrl,
        file,
      });
      nextImageCount += 1;
    }

    if (nextImages.length === 1 && nextImages[0]) {
      addComposerImage(nextImages[0]);
    } else if (nextImages.length > 1) {
      addComposerImagesToDraft(nextImages);
    }
    setThreadError(activeThreadId, error);
  };

  const removeComposerImage = (imageId: string) => {
    removeComposerImageFromDraft(imageId);
  };

  const onComposerPaste = (event: React.ClipboardEvent<HTMLElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) {
      return;
    }
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      return;
    }
    event.preventDefault();
    addComposerImages(imageFiles);
  };

  const onComposerDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOverComposer(true);
  };

  const onComposerDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDragOverComposer(true);
  };

  const onComposerDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragOverComposer(false);
    }
  };

  const onComposerDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOverComposer(false);
    const files = Array.from(event.dataTransfer.files);
    addComposerImages(files);
    focusComposer();
  };

  return (
    <div className={cn("px-3 pt-1.5 sm:px-5 sm:pt-2", isGitRepo ? "pb-1" : "pb-3 sm:pb-4")}>
      <form
        ref={composerFormRef}
        onSubmit={onSend}
        className="mx-auto w-full min-w-0 max-w-3xl"
        data-chat-composer-form="true"
      >
        <div
          className={`group rounded-[20px] border bg-card transition-colors duration-200 focus-within:border-ring/45 ${
            isDragOverComposer ? "border-primary/70 bg-accent/30" : "border-border"
          }`}
          onDragEnter={onComposerDragEnter}
          onDragOver={onComposerDragOver}
          onDragLeave={onComposerDragLeave}
          onDrop={onComposerDrop}
        >
          {activePendingApproval ? (
            <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
              <ComposerPendingApprovalPanel
                approval={activePendingApproval}
                pendingCount={pendingApprovals.length}
              />
            </div>
          ) : pendingUserInputs.length > 0 ? (
            <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
              <ComposerPendingUserInputPanel
                pendingUserInputs={pendingUserInputs}
                respondingRequestIds={respondingUserInputRequestIds}
                answers={activePendingDraftAnswers}
                questionIndex={activePendingQuestionIndex}
                onSelectOption={onSelectActivePendingUserInputOption}
                onAdvance={onAdvanceActivePendingUserInput}
              />
            </div>
          ) : showPlanFollowUpPrompt && activeProposedPlan ? (
            <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
              <ComposerPlanFollowUpBanner
                key={activeProposedPlan.id}
                planTitle={proposedPlanTitle(activeProposedPlan.planMarkdown) ?? null}
              />
            </div>
          ) : null}

          {/* Textarea area */}
          <div
            className={cn(
              "relative px-3 pb-2 sm:px-4",
              hasComposerHeader ? "pt-2.5 sm:pt-3" : "pt-3.5 sm:pt-4",
            )}
          >
            {composerMenuOpen && !isComposerApprovalState && (
              <div className="absolute inset-x-0 bottom-full z-20 mb-2 px-1">
                <ComposerCommandMenu
                  items={composerMenuItems}
                  resolvedTheme={resolvedTheme}
                  isLoading={isComposerMenuLoading}
                  triggerKind={composerTriggerKind}
                  activeItemId={activeComposerMenuItem?.id ?? null}
                  onHighlightedItemChange={onComposerMenuItemHighlighted}
                  onSelect={onSelectComposerItem}
                />
              </div>
            )}

            {!isComposerApprovalState &&
              pendingUserInputs.length === 0 &&
              composerImages.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-2">
                  {composerImages.map((image) => (
                    <div
                      key={image.id}
                      className="relative h-16 w-16 overflow-hidden rounded-lg border border-border/80 bg-background"
                    >
                      {image.previewUrl ? (
                        <button
                          type="button"
                          className="h-full w-full cursor-zoom-in"
                          aria-label={`Preview ${image.name}`}
                          onClick={() => {
                            const preview = buildExpandedImagePreview(composerImages, image.id);
                            if (!preview) return;
                            setExpandedImage(preview);
                          }}
                        >
                          <img
                            src={image.previewUrl}
                            alt={image.name}
                            className="h-full w-full object-cover"
                          />
                        </button>
                      ) : (
                        <div className="flex h-full w-full items-center justify-center px-1 text-center text-[10px] text-muted-foreground/70">
                          {image.name}
                        </div>
                      )}
                      {nonPersistedComposerImageIdSet.has(image.id) && (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <span
                                role="img"
                                aria-label="Draft attachment may not persist"
                                className="absolute left-1 top-1 inline-flex items-center justify-center rounded bg-background/85 p-0.5 text-amber-600"
                              >
                                <CircleAlertIcon className="size-3" />
                              </span>
                            }
                          />
                          <TooltipPopup
                            side="top"
                            className="max-w-64 whitespace-normal leading-tight"
                          >
                            Draft attachment could not be saved locally and may be lost on
                            navigation.
                          </TooltipPopup>
                        </Tooltip>
                      )}
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="absolute right-1 top-1 bg-background/80 hover:bg-background/90"
                        onClick={() => removeComposerImage(image.id)}
                        aria-label={`Remove ${image.name}`}
                      >
                        <XIcon />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            <ComposerPromptEditor
              ref={composerEditorRef}
              value={
                isComposerApprovalState
                  ? ""
                  : activePendingProgress
                    ? activePendingProgress.customAnswer
                    : prompt
              }
              cursor={composerCursor}
              onChange={onPromptChange}
              onCommandKeyDown={onComposerCommandKey}
              onPaste={onComposerPaste}
              placeholder={
                isComposerApprovalState
                  ? (activePendingApproval?.detail ?? "Resolve this approval request to continue")
                  : activePendingProgress
                    ? "Type your own answer, or leave this blank to use the selected option"
                    : showPlanFollowUpPrompt && activeProposedPlan
                      ? "Add feedback to refine the plan, or leave this blank to implement it"
                      : phase === "disconnected"
                        ? "Ask for follow-up changes or attach images"
                        : "Ask anything, @tag files/folders, or use / to show available commands"
              }
              disabled={isConnecting || isComposerApprovalState}
            />
          </div>

          {/* Bottom toolbar */}
          {activePendingApproval ? (
            <div className="flex items-center justify-end gap-2 px-2.5 pb-2.5 sm:px-3 sm:pb-3">
              <ComposerPendingApprovalActions
                requestId={activePendingApproval.requestId}
                isResponding={respondingRequestIds.includes(activePendingApproval.requestId)}
                onRespondToApproval={onRespondToApproval}
              />
            </div>
          ) : (
            <div
              data-chat-composer-footer="true"
              className={cn(
                "flex items-center justify-between px-2.5 pb-2.5 sm:px-3 sm:pb-3",
                isComposerFooterCompact ? "gap-1.5" : "flex-wrap gap-2 sm:flex-nowrap sm:gap-0",
              )}
            >
              <div
                className={cn(
                  "flex min-w-0 flex-1 items-center",
                  isComposerFooterCompact
                    ? "gap-1 overflow-hidden"
                    : "gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:min-w-max sm:overflow-visible",
                )}
              >
                {/* Provider/model picker */}
                <ProviderModelPicker
                  compact={isComposerFooterCompact}
                  provider={selectedProvider}
                  model={selectedModelForPickerWithCustomFallback}
                  lockedProvider={lockedProvider}
                  modelOptionsByProvider={modelOptionsByProvider}
                  onProviderModelChange={onProviderModelSelect}
                />

                {isComposerFooterCompact ? (
                  <CompactComposerControlsMenu
                    activePlan={Boolean(activePlan || activeProposedPlan || planSidebarOpen)}
                    interactionMode={interactionMode}
                    planSidebarOpen={planSidebarOpen}
                    runtimeMode={runtimeMode}
                    selectedEffort={selectedEffort}
                    selectedProvider={selectedProvider}
                    selectedCodexFastModeEnabled={selectedCodexFastModeEnabled}
                    reasoningOptions={reasoningOptions}
                    onEffortSelect={onEffortSelect}
                    onCodexFastModeChange={onCodexFastModeChange}
                    onToggleInteractionMode={toggleInteractionMode}
                    onTogglePlanSidebar={togglePlanSidebar}
                    onToggleRuntimeMode={toggleRuntimeMode}
                  />
                ) : (
                  <>
                    {selectedProvider === "codex" && selectedEffort != null ? (
                      <>
                        <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
                        <CodexTraitsPicker
                          effort={selectedEffort}
                          fastModeEnabled={selectedCodexFastModeEnabled}
                          options={reasoningOptions}
                          onEffortChange={onEffortSelect}
                          onFastModeChange={onCodexFastModeChange}
                        />
                      </>
                    ) : null}

                    <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />

                    <Button
                      variant="ghost"
                      className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
                      size="sm"
                      type="button"
                      onClick={toggleInteractionMode}
                      title={
                        interactionMode === "plan"
                          ? "Plan mode — click to return to normal chat mode"
                          : "Default mode — click to enter plan mode"
                      }
                    >
                      <BotIcon />
                      <span className="sr-only sm:not-sr-only">
                        {interactionMode === "plan" ? "Plan" : "Chat"}
                      </span>
                    </Button>

                    <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />

                    <Button
                      variant="ghost"
                      className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
                      size="sm"
                      type="button"
                      onClick={() =>
                        void handleRuntimeModeChange(
                          runtimeMode === "full-access" ? "approval-required" : "full-access",
                        )
                      }
                      title={
                        runtimeMode === "full-access"
                          ? "Full access — click to require approvals"
                          : "Approval required — click for full access"
                      }
                    >
                      {runtimeMode === "full-access" ? <LockOpenIcon /> : <LockIcon />}
                      <span className="sr-only sm:not-sr-only">
                        {runtimeMode === "full-access" ? "Full access" : "Supervised"}
                      </span>
                    </Button>

                    {activePlan || activeProposedPlan || planSidebarOpen ? (
                      <>
                        <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
                        <Button
                          variant="ghost"
                          className={cn(
                            "shrink-0 whitespace-nowrap px-2 sm:px-3",
                            planSidebarOpen
                              ? "text-blue-400 hover:text-blue-300"
                              : "text-muted-foreground/70 hover:text-foreground/80",
                          )}
                          size="sm"
                          type="button"
                          onClick={togglePlanSidebar}
                          title={planSidebarOpen ? "Hide plan sidebar" : "Show plan sidebar"}
                        >
                          <ListTodoIcon />
                          <span className="sr-only sm:not-sr-only">Plan</span>
                        </Button>
                      </>
                    ) : null}
                  </>
                )}
              </div>

              {/* Right side: send / stop button */}
              <div data-chat-composer-actions="right" className="flex shrink-0 items-center gap-2">
                {isPreparingWorktree ? (
                  <span className="text-muted-foreground/70 text-xs">Preparing worktree...</span>
                ) : null}
                {activePendingProgress ? (
                  <div className="flex items-center gap-2">
                    {activePendingProgress.questionIndex > 0 ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="rounded-full"
                        onClick={onPreviousActivePendingUserInputQuestion}
                        disabled={activePendingIsResponding}
                      >
                        Previous
                      </Button>
                    ) : null}
                    <Button
                      type="submit"
                      size="sm"
                      className="rounded-full px-4"
                      disabled={
                        activePendingIsResponding ||
                        (activePendingProgress.isLastQuestion
                          ? !activePendingResolvedAnswers
                          : !activePendingProgress.canAdvance)
                      }
                    >
                      {activePendingIsResponding
                        ? "Submitting..."
                        : activePendingProgress.isLastQuestion
                          ? "Submit answers"
                          : "Next question"}
                    </Button>
                  </div>
                ) : phase === "running" ? (
                  <button
                    type="button"
                    className="flex size-8 items-center justify-center rounded-full bg-rose-500/90 text-white transition-all duration-150 hover:bg-rose-500 hover:scale-105 sm:h-8 sm:w-8"
                    onClick={() => void onInterrupt()}
                    aria-label="Stop generation"
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 12 12"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <rect x="2" y="2" width="8" height="8" rx="1.5" />
                    </svg>
                  </button>
                ) : pendingUserInputs.length === 0 ? (
                  showPlanFollowUpPrompt ? (
                    prompt.trim().length > 0 ? (
                      <Button
                        type="submit"
                        size="sm"
                        className="h-9 rounded-full px-4 sm:h-8"
                        disabled={isSendBusy || isConnecting}
                      >
                        {isConnecting || isSendBusy ? "Sending..." : "Refine"}
                      </Button>
                    ) : (
                      <div className="flex items-center">
                        <Button
                          type="submit"
                          size="sm"
                          className="h-9 rounded-l-full rounded-r-none px-4 sm:h-8"
                          disabled={isSendBusy || isConnecting}
                        >
                          {isConnecting || isSendBusy ? "Sending..." : "Implement"}
                        </Button>
                        <Menu>
                          <MenuTrigger
                            render={
                              <Button
                                size="sm"
                                variant="default"
                                className="h-9 rounded-l-none rounded-r-full border-l-white/12 px-2 sm:h-8"
                                aria-label="Implementation actions"
                                disabled={isSendBusy || isConnecting}
                              />
                            }
                          >
                            <ChevronDownIcon className="size-3.5" />
                          </MenuTrigger>
                          <MenuPopup align="end" side="top">
                            <MenuItem
                              disabled={isSendBusy || isConnecting}
                              onClick={() => void onImplementPlanInNewThread()}
                            >
                              Implement in new thread
                            </MenuItem>
                          </MenuPopup>
                        </Menu>
                      </div>
                    )
                  ) : (
                    <button
                      type="submit"
                      className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/90 text-primary-foreground transition-all duration-150 hover:bg-primary hover:scale-105 disabled:opacity-30 disabled:hover:scale-100 sm:h-8 sm:w-8"
                      disabled={
                        isSendBusy ||
                        isConnecting ||
                        (!prompt.trim() && composerImages.length === 0)
                      }
                      aria-label={
                        isConnecting
                          ? "Connecting"
                          : isPreparingWorktree
                            ? "Preparing worktree"
                            : isSendBusy
                              ? "Sending"
                              : "Send message"
                      }
                    >
                      {isConnecting || isSendBusy ? (
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 14 14"
                          fill="none"
                          className="animate-spin"
                          aria-hidden="true"
                        >
                          <circle
                            cx="7"
                            cy="7"
                            r="5.5"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeDasharray="20 12"
                          />
                        </svg>
                      ) : (
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 14 14"
                          fill="none"
                          aria-hidden="true"
                        >
                          <path
                            d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      )}
                    </button>
                  )
                ) : null}
              </div>
            </div>
          )}
        </div>
      </form>
    </div>
  );
}
