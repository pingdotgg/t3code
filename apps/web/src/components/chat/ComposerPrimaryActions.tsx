import {
  memo,
  useEffect,
  useState,
  type MouseEventHandler,
  type PointerEventHandler,
  type ReactNode,
} from "react";
import {
  CheckIcon,
  ChevronLeftIcon,
  Minimize2Icon,
  PlayIcon,
  CornerUpRightIcon,
  ListPlusIcon,
} from "lucide-react";
import { useEnvironmentIdentificationMode } from "~/hooks/useSettings";
import { formatContextWindowTokens } from "~/lib/contextWindow";
import { cn, isMacPlatform } from "~/lib/utils";
import { useShortcutModifierState } from "../../shortcutModifierState";
import { StageBackdropButtonArt, useSidebarStageBackdropVariant } from "../SidebarStageBackdrop";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  alternateComposerDispatchAction,
  resolveComposerDispatchMode,
} from "@t3tools/client-runtime/state/composer-dispatch";

interface PendingActionState {
  questionIndex: number;
  isLastQuestion: boolean;
  canAdvance: boolean;
  isResponding: boolean;
  isComplete: boolean;
}

interface ComposerPrimaryActionsProps {
  /** Footer controls (dictation) that always sit right before the primary button. */
  children?: ReactNode;
  compact: boolean;
  canOperateThread: boolean;
  pendingAction: PendingActionState | null;
  isRunning: boolean;
  canInterrupt: boolean;
  runId?: string | null;
  followUpBehavior?: "queue" | "steer";
  canSteer?: boolean;
  alternateShortcutLabel?: string | null;
  /** Dictation is running; Send finishes it and submits once the transcript lands. */
  voiceInputActive?: boolean;
  isSendBusy: boolean;
  sendDisabledReason: string | null;
  isEnvironmentUnavailable: boolean;
  isPreparingWorktree: boolean;
  hasSendableContent: boolean;
  canResume?: boolean;
  preserveComposerFocusOnPointerDown?: boolean;
  isEditingQueuedMessage?: boolean;
  onSubmitMessage?: MouseEventHandler<HTMLButtonElement>;
  onResume?: () => void;
  onPreviousPendingQuestion: () => void;
  onInterrupt: () => void;
  compactBeforeSendTokens?: number | null;
  hideCompactToggle?: boolean;
  keepFullHistory?: boolean;
  onToggleKeepFullHistory?: () => void;
}

const formatPendingPrimaryActionLabel = (input: {
  compact: boolean;
  isLastQuestion: boolean;
  isResponding: boolean;
  questionIndex: number;
}) => {
  if (input.isResponding) {
    return "Submitting...";
  }
  if (input.compact) {
    return input.isLastQuestion ? "Submit" : "Next";
  }
  if (!input.isLastQuestion) {
    return "Next question";
  }
  return input.questionIndex > 0 ? "Submit answers" : "Submit answer";
};

const STOP_PENDING_MAX_MS = 10_000;
// The action that takes Stop's place ignores clicks this long, so repeat Stop clicks can't resume.
const STOP_LANDED_CLICK_GUARD_MS = 500;

const messageActionPillClassName =
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-message-action font-medium text-base text-message-action-foreground shadow-xs shadow-message-action/24 outline-none hover:bg-message-action-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 disabled:shadow-none sm:text-sm";

const preventPointerFocus: PointerEventHandler<HTMLElement> = (event) => {
  event.preventDefault();
};

type StopPhase = "pending" | "timedOut" | "landed" | null;

function useStopPhase(input: {
  runId: string | null;
  canInterrupt: boolean;
  canOperateThread: boolean;
}) {
  const { runId, canInterrupt, canOperateThread } = input;
  const [stopPhase, setStopPhase] = useState<StopPhase>(null);
  const [stopRunId, setStopRunId] = useState(runId);
  if (runId !== null && stopRunId !== runId) {
    setStopRunId(runId);
    setStopPhase(null);
  } else if (canOperateThread) {
    // Losing permission also clears canInterrupt; it does not acknowledge the stop.
    if ((stopPhase === "pending" || stopPhase === "timedOut") && !canInterrupt)
      setStopPhase("landed");
    else if (stopPhase === "landed" && canInterrupt) setStopPhase(null);
  }
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- timers that re-enable an unsettled Stop and end the landed click guard
  useEffect(() => {
    if (stopPhase === "pending") {
      const timeout = setTimeout(() => setStopPhase("timedOut"), STOP_PENDING_MAX_MS);
      return () => clearTimeout(timeout);
    }
    if (stopPhase === "landed") {
      const timeout = setTimeout(() => setStopPhase(null), STOP_LANDED_CLICK_GUARD_MS);
      return () => clearTimeout(timeout);
    }
  }, [stopPhase]);
  return [stopPhase, setStopPhase] as const;
}

function StopGenerationButton({
  stopPhase,
  canOperateThread,
  insidePendingAction,
  preserveComposerFocusOnPointerDown,
  onStopRequested,
  onInterrupt,
}: {
  stopPhase: StopPhase;
  canOperateThread: boolean;
  insidePendingAction: boolean;
  preserveComposerFocusOnPointerDown: boolean;
  onStopRequested: () => void;
  onInterrupt: () => void;
}) {
  const isStopDisabled = stopPhase === "pending";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(
              "flex shrink-0 cursor-pointer items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs shadow-destructive/24 inset-shadow-control-highlight transition-colors duration-150 hover:bg-destructive active:inset-shadow-control-pressed active:shadow-none disabled:cursor-default disabled:opacity-64 disabled:hover:bg-destructive/90 [&_svg]:pointer-events-none",
              insidePendingAction ? "size-8 sm:size-7" : "size-8 sm:h-8 sm:w-8",
            )}
            onPointerDown={preserveComposerFocusOnPointerDown ? preventPointerFocus : undefined}
            disabled={!canOperateThread || isStopDisabled}
            onClick={() => {
              if (!canOperateThread || isStopDisabled) return;
              onStopRequested();
              onInterrupt();
            }}
            aria-label={stopPhase === "pending" ? "Stopping" : "Stop generation"}
          />
        }
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
          <rect x="2" y="2" width="8" height="8" rx="1.5" />
        </svg>
      </TooltipTrigger>
      <TooltipPopup>{stopPhase === "pending" ? "Stopping…" : "Interrupt"}</TooltipPopup>
    </Tooltip>
  );
}

/** The collapsed mobile composer's Stop, shown in place of `children` while a turn can be stopped. */
export function CollapsedComposerStopAction({
  children,
  canOperateThread,
  canInterrupt,
  runId,
  hasSendableContent,
  isEditingQueuedMessage,
  onInterrupt,
}: {
  children: ReactNode;
  canOperateThread: boolean;
  canInterrupt: boolean;
  runId: string | null;
  hasSendableContent: boolean;
  isEditingQueuedMessage: boolean;
  onInterrupt: () => void;
}) {
  const [stopPhase, setStopPhase] = useStopPhase({ runId, canInterrupt, canOperateThread });
  if (
    !(canInterrupt || stopPhase === "pending" || stopPhase === "timedOut") ||
    hasSendableContent ||
    isEditingQueuedMessage
  ) {
    return children;
  }
  return (
    <span
      data-chat-composer-transition-actions="true"
      data-chat-composer-collapsed-controls="true"
      className="flex shrink-0"
    >
      <StopGenerationButton
        stopPhase={stopPhase}
        canOperateThread={canOperateThread}
        insidePendingAction={false}
        preserveComposerFocusOnPointerDown
        onStopRequested={() => setStopPhase("pending")}
        onInterrupt={onInterrupt}
      />
    </span>
  );
}

export const ComposerPrimaryActions = memo(function ComposerPrimaryActions({
  children,
  compact,
  canOperateThread,
  pendingAction,
  isRunning,
  canInterrupt,
  runId = null,
  followUpBehavior = "steer",
  canSteer = true,
  alternateShortcutLabel = null,
  voiceInputActive = false,
  isSendBusy,
  sendDisabledReason,
  isEnvironmentUnavailable,
  isPreparingWorktree,
  hasSendableContent,
  canResume = false,
  preserveComposerFocusOnPointerDown = false,
  isEditingQueuedMessage = false,
  onSubmitMessage,
  onResume,
  onPreviousPendingQuestion,
  onInterrupt,
  compactBeforeSendTokens = null,
  hideCompactToggle = false,
  keepFullHistory = false,
  onToggleKeepFullHistory,
}: ComposerPrimaryActionsProps) {
  const [stopPhase, setStopPhase] = useStopPhase({ runId, canInterrupt, canOperateThread });
  const pointerFocusProps = preserveComposerFocusOnPointerDown
    ? { onPointerDown: preventPointerFocus }
    : undefined;
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const shortcutModifiers = useShortcutModifierState();
  const isQueuing =
    !isEditingQueuedMessage &&
    resolveComposerDispatchMode({
      running: isRunning,
      activeTurnDefault: followUpBehavior,
      canSteer,
      alternateModifier: shortcutModifiers.metaKey || shortcutModifiers.ctrlKey,
    }) === "queue";
  const alternateAction = alternateComposerDispatchAction(followUpBehavior);
  const isSendDisabled = !canOperateThread || sendDisabledReason !== null;
  const stageBackdropVariant = useSidebarStageBackdropVariant(environmentIdentificationMode);

  const renderStopGenerationButton = (insidePendingAction: boolean) => (
    <StopGenerationButton
      key="interrupt"
      stopPhase={stopPhase}
      canOperateThread={canOperateThread}
      insidePendingAction={insidePendingAction}
      preserveComposerFocusOnPointerDown={preserveComposerFocusOnPointerDown}
      onStopRequested={() => setStopPhase("pending")}
      onInterrupt={onInterrupt}
    />
  );

  // Keep the clicked target at the right edge even if typing changes the primary action.
  const withStopButton = (action: ReactNode) => (
    <>
      {action}
      {stopPhase === "pending" || stopPhase === "timedOut"
        ? renderStopGenerationButton(false)
        : null}
    </>
  );

  if (pendingAction) {
    return (
      <div className={cn("flex items-center justify-end", compact ? "gap-1.5" : "gap-2")}>
        {pendingAction.questionIndex > 0 ? (
          compact ? (
            <Button
              size="icon-sm"
              variant="outline"
              {...pointerFocusProps}
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
              aria-label="Previous question"
            >
              <ChevronLeftIcon className="size-3.5" />
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              {...pointerFocusProps}
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
            >
              Previous
            </Button>
          )
        ) : null}
        {children}
        <button
          type="submit"
          className={cn(messageActionPillClassName, "h-8 sm:h-7", compact ? "px-3" : "px-4")}
          {...pointerFocusProps}
          onClick={(event) => {
            if (stopPhase === "landed") event.preventDefault();
          }}
          disabled={
            !canOperateThread ||
            isEnvironmentUnavailable ||
            isSendDisabled ||
            pendingAction.isResponding ||
            (!voiceInputActive &&
              (pendingAction.isLastQuestion
                ? !pendingAction.isComplete
                : !pendingAction.canAdvance))
          }
        >
          {formatPendingPrimaryActionLabel({
            compact,
            isLastQuestion: pendingAction.isLastQuestion,
            isResponding: pendingAction.isResponding,
            questionIndex: pendingAction.questionIndex,
          })}
        </button>
        {canInterrupt || stopPhase === "pending" || stopPhase === "timedOut"
          ? renderStopGenerationButton(true)
          : null}
      </div>
    );
  }

  if (
    (canInterrupt || stopPhase === "pending" || stopPhase === "timedOut") &&
    !hasSendableContent &&
    !isEditingQueuedMessage
  ) {
    return (
      <>
        {children}
        {renderStopGenerationButton(false)}
      </>
    );
  }

  const showResume = canResume && !hasSendableContent && !isEditingQueuedMessage;

  const compactTokens =
    compactBeforeSendTokens !== null && !showResume && !isEditingQueuedMessage
      ? formatContextWindowTokens(compactBeforeSendTokens)
      : null;
  const compactsBeforeSend = compactTokens !== null && !keepFullHistory;

  const submitLabel = showResume
    ? "Resume thread"
    : isEditingQueuedMessage
      ? "Update queued message"
      : compactsBeforeSend
        ? "Compact and send"
        : isQueuing
          ? "Queue message"
          : isRunning
            ? "Steer message"
            : "Submit message";
  const submitStatus = isEnvironmentUnavailable
    ? "Environment disconnected"
    : (sendDisabledReason ??
      (isPreparingWorktree
        ? "Preparing worktree"
        : isSendBusy
          ? isEditingQueuedMessage
            ? "Updating queued message"
            : "Submitting message"
          : null));
  const submitTooltip =
    submitStatus ??
    (compactsBeforeSend
      ? `Summarize ${compactTokens} tokens of history, then send`
      : isRunning && !isEditingQueuedMessage && canSteer
        ? `Click to ${followUpBehavior}, ${isMacPlatform(navigator.platform) ? "⌘" : "Ctrl"}-click${alternateShortcutLabel ? ` or ${alternateShortcutLabel}` : ""} to ${alternateAction}`
        : submitLabel);

  const sendButton = (
    <button
      type={showResume ? "button" : "submit"}
      className={cn(
        "relative isolate flex h-9 w-9 items-center justify-center overflow-hidden rounded-full shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-control-highlight hover:scale-105 active:inset-shadow-control-pressed active:shadow-none disabled:pointer-events-none disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8 [&_svg]:pointer-events-none",
        stageBackdropVariant
          ? "bg-transparent text-white enabled:shadow-black/24 enabled:hover:brightness-110 disabled:opacity-64"
          : "bg-message-action text-message-action-foreground enabled:shadow-message-action/24 hover:bg-message-action-hover disabled:bg-foreground/12 disabled:text-muted-foreground",
      )}
      {...pointerFocusProps}
      onClick={(event) => {
        if (stopPhase === "landed") {
          event.preventDefault();
          return;
        }
        if (showResume) onResume?.();
        else onSubmitMessage?.(event);
      }}
      disabled={
        isSendBusy ||
        isSendDisabled ||
        isEnvironmentUnavailable ||
        (!hasSendableContent && !showResume)
      }
      aria-label={submitStatus ?? submitLabel}
    >
      {stageBackdropVariant ? (
        <span className="pointer-events-none absolute inset-0 -z-10" aria-hidden="true">
          <StageBackdropButtonArt variant={stageBackdropVariant} />
        </span>
      ) : null}
      {isSendBusy ? (
        <Spinner size="sm" aria-hidden="true" />
      ) : showResume ? (
        <PlayIcon className="size-4 fill-current" aria-hidden="true" />
      ) : isEditingQueuedMessage ? (
        <CheckIcon className="size-4" aria-hidden="true" />
      ) : isRunning && isQueuing ? (
        <ListPlusIcon className="size-4" aria-hidden="true" />
      ) : isRunning ? (
        <CornerUpRightIcon className="size-4" aria-hidden="true" />
      ) : (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
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
  );

  const submit = (
    <Tooltip key="submit">
      <TooltipTrigger render={<span className="inline-flex" />}>{sendButton}</TooltipTrigger>
      <TooltipPopup>{submitTooltip}</TooltipPopup>
    </Tooltip>
  );
  if (compactTokens === null || hideCompactToggle) {
    return withStopButton(
      <>
        {children}
        {submit}
      </>,
    );
  }

  return withStopButton(
    <div data-chat-composer-compact-send="true" className="flex items-center gap-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-(--control-radius) px-2 font-medium text-base text-foreground/80 tabular-nums outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-64 sm:text-sm aria-pressed:bg-accent/60 aria-pressed:text-foreground [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:text-muted-foreground"
              {...pointerFocusProps}
              aria-pressed={!keepFullHistory}
              aria-label={`Compact ${compactTokens} tokens of history before sending`}
              disabled={!canOperateThread}
              onClick={onToggleKeepFullHistory}
            />
          }
        >
          <Minimize2Icon aria-hidden="true" />
          <span className="@max-[480px]/composer-surface:hidden">
            {keepFullHistory ? "Keep" : "Compact"}
          </span>
          <span className="text-muted-foreground">{compactTokens}</span>
        </TooltipTrigger>
        <TooltipPopup>
          <div>
            {keepFullHistory
              ? `Next send keeps all ${compactTokens} tokens.`
              : `Next send compacts ${compactTokens} tokens first.`}
          </div>
          <div>{keepFullHistory ? "Click to compact first" : "Click to keep full history"}</div>
        </TooltipPopup>
      </Tooltip>
      {children}
      {submit}
    </div>,
  );
});
