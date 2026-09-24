import { memo, type MouseEventHandler, type PointerEventHandler } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  CornerUpRightIcon,
  ListPlusIcon,
} from "lucide-react";
import { useEnvironmentIdentificationMode } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { useShortcutModifierState } from "../../shortcutModifierState";
import { StageBackdropButtonArt, useSidebarStageBackdropVariant } from "../SidebarStageBackdrop";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { composerFloatingLayerProps } from "./composerEventScope";
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
  compact: boolean;
  pendingAction: PendingActionState | null;
  isRunning: boolean;
  followUpBehavior?: "queue" | "steer";
  alternateShortcutLabel?: string | null;
  showPlanFollowUpPrompt: boolean;
  promptHasText: boolean;
  isSendBusy: boolean;
  sendDisabledReason: string | null;
  isConnecting: boolean;
  isEnvironmentUnavailable: boolean;
  isPreparingWorktree: boolean;
  hasSendableContent: boolean;
  preserveComposerFocusOnPointerDown?: boolean;
  isEditingQueuedMessage?: boolean;
  onSubmitMessage?: MouseEventHandler<HTMLButtonElement>;
  onPreviousPendingQuestion: () => void;
  /** Whether Stop is available, including for a run that has not reached `isRunning` yet. */
  canInterrupt?: boolean;
  onInterrupt: () => void;
  onImplementPlanInNewThread: () => void;
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

// The composer's labeled primary actions (Submit, Refine, Implement) share the send button's
// message-action pill, so they are composer-owned buttons rather than restyled Buttons.
const messageActionPillClassName =
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-message-action font-medium text-base text-message-action-foreground shadow-xs shadow-message-action/24 outline-none hover:bg-message-action-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 disabled:shadow-none sm:text-sm";

const preventPointerFocus: PointerEventHandler<HTMLElement> = (event) => {
  event.preventDefault();
};

export const ComposerPrimaryActions = memo(function ComposerPrimaryActions({
  compact,
  pendingAction,
  isRunning,
  followUpBehavior = "steer",
  alternateShortcutLabel = null,
  showPlanFollowUpPrompt,
  promptHasText,
  isSendBusy,
  sendDisabledReason,
  isConnecting,
  isEnvironmentUnavailable,
  isPreparingWorktree,
  hasSendableContent,
  preserveComposerFocusOnPointerDown = false,
  isEditingQueuedMessage = false,
  onSubmitMessage,
  onPreviousPendingQuestion,
  canInterrupt = false,
  onInterrupt,
  onImplementPlanInNewThread,
}: ComposerPrimaryActionsProps) {
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
      alternateModifier: shortcutModifiers.metaKey || shortcutModifiers.ctrlKey,
    }) === "queue";
  const alternateAction = alternateComposerDispatchAction(followUpBehavior);
  const isSendDisabled = sendDisabledReason !== null;
  const stageBackdropVariant = useSidebarStageBackdropVariant(
    environmentIdentificationMode === "artwork",
  );

  const renderStopGenerationButton = (insidePendingAction: boolean) => (
    <Tooltip key="interrupt">
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(
              "flex cursor-pointer items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs shadow-destructive/24 inset-shadow-[0_1px_--theme(--color-white/16%)] transition-all duration-150 hover:bg-destructive hover:scale-105 active:inset-shadow-[0_1px_--theme(--color-black/8%)] active:shadow-none [&_svg]:pointer-events-none",
              insidePendingAction ? "size-8 sm:size-7" : "size-8 sm:h-8 sm:w-8",
            )}
            {...pointerFocusProps}
            onClick={onInterrupt}
            aria-label="Stop generation"
          />
        }
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
          <rect x="2" y="2" width="8" height="8" rx="1.5" />
        </svg>
      </TooltipTrigger>
      <TooltipPopup>Interrupt</TooltipPopup>
    </Tooltip>
  );

  if (pendingAction) {
    return (
      <div className={cn("flex items-center justify-end", compact ? "gap-1.5" : "gap-2")}>
        {isRunning ? renderStopGenerationButton(true) : null}
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
        <button
          type="submit"
          className={cn(messageActionPillClassName, "h-8 sm:h-7", compact ? "px-3" : "px-4")}
          {...pointerFocusProps}
          disabled={
            isEnvironmentUnavailable ||
            pendingAction.isResponding ||
            (pendingAction.isLastQuestion ? !pendingAction.isComplete : !pendingAction.canAdvance)
          }
        >
          {formatPendingPrimaryActionLabel({
            compact,
            isLastQuestion: pendingAction.isLastQuestion,
            isResponding: pendingAction.isResponding,
            questionIndex: pendingAction.questionIndex,
          })}
        </button>
      </div>
    );
  }

  if (showPlanFollowUpPrompt) {
    if (promptHasText) {
      return (
        <button
          type="submit"
          className={cn(messageActionPillClassName, "h-9 sm:h-8", compact ? "px-3" : "px-4")}
          {...pointerFocusProps}
          disabled={isSendBusy || isSendDisabled || isConnecting || isEnvironmentUnavailable}
        >
          {isConnecting || isSendBusy ? "Sending..." : "Refine"}
        </button>
      );
    }

    return (
      <div data-chat-composer-implement-actions="true" className="flex items-center justify-end">
        <button
          type="submit"
          className={cn(messageActionPillClassName, "h-9 rounded-r-none px-4 sm:h-8")}
          {...pointerFocusProps}
          disabled={isSendBusy || isSendDisabled || isConnecting || isEnvironmentUnavailable}
        >
          {isConnecting || isSendBusy ? "Sending..." : "Implement"}
        </button>
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                className={cn(
                  messageActionPillClassName,
                  "h-9 rounded-l-none border-l border-message-action-foreground/20 px-2 sm:h-8",
                )}
                aria-label="Implementation actions"
                {...pointerFocusProps}
                disabled={isSendBusy || isSendDisabled || isConnecting || isEnvironmentUnavailable}
              />
            }
          >
            <ChevronDownIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end" side="top" {...composerFloatingLayerProps}>
            <MenuItem
              disabled={isSendBusy || isSendDisabled || isConnecting || isEnvironmentUnavailable}
              onClick={() => void onImplementPlanInNewThread()}
            >
              Implement in a new thread
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    );
  }

  if (isRunning && !hasSendableContent && !isEditingQueuedMessage) {
    return renderStopGenerationButton(false);
  }

  // A run that is still starting cannot take a message yet, so Stop replaces the send spinner.
  if (canInterrupt && !isRunning && !isEditingQueuedMessage) {
    return renderStopGenerationButton(false);
  }

  const submitLabel = isEditingQueuedMessage
    ? "Update queued message"
    : isQueuing
      ? "Queue message"
      : isRunning
        ? "Steer message"
        : "Submit message";
  const submitStatus = isEnvironmentUnavailable
    ? "Environment disconnected"
    : (sendDisabledReason ??
      (isConnecting
        ? "Connecting"
        : isPreparingWorktree
          ? "Preparing worktree"
          : isSendBusy
            ? isEditingQueuedMessage
              ? "Updating queued message"
              : "Submitting message"
            : null));
  const submitTooltip =
    submitStatus ??
    (isRunning && !isEditingQueuedMessage
      ? `Click to ${followUpBehavior}, Ctrl/⌘-click${alternateShortcutLabel ? ` or ${alternateShortcutLabel}` : ""} to ${alternateAction}`
      : submitLabel);

  const sendButton = (
    <button
      type="submit"
      className={cn(
        "relative isolate flex h-9 w-9 items-center justify-center overflow-hidden rounded-full shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-[0_1px_--theme(--color-white/16%)] hover:scale-105 active:inset-shadow-[0_1px_--theme(--color-black/8%)] active:shadow-none disabled:pointer-events-none disabled:opacity-30 disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8 [&_svg]:pointer-events-none",
        stageBackdropVariant
          ? "bg-transparent text-white enabled:shadow-black/24 enabled:hover:brightness-110"
          : "bg-message-action text-message-action-foreground enabled:shadow-message-action/24 hover:bg-message-action-hover",
      )}
      {...pointerFocusProps}
      onClick={onSubmitMessage}
      disabled={
        isSendBusy ||
        isSendDisabled ||
        isConnecting ||
        isEnvironmentUnavailable ||
        !hasSendableContent
      }
      aria-label={submitStatus ?? submitLabel}
    >
      {stageBackdropVariant ? (
        <span className="pointer-events-none absolute inset-0 -z-10" aria-hidden="true">
          <StageBackdropButtonArt variant={stageBackdropVariant} />
        </span>
      ) : null}
      {isConnecting || isSendBusy ? (
        <Spinner size="sm" aria-hidden="true" />
      ) : isEditingQueuedMessage ? (
        <CheckIcon className="size-4" aria-hidden="true" />
      ) : isQueuing ? (
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

  return (
    <Tooltip key="submit">
      <TooltipTrigger render={<span className="inline-flex" />}>{sendButton}</TooltipTrigger>
      <TooltipPopup>{submitTooltip}</TooltipPopup>
    </Tooltip>
  );
});
