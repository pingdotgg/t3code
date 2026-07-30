import { memo, type PointerEventHandler } from "react";
import {
  IconChevronDown as ChevronDownIcon,
  IconChevronLeft as ChevronLeftIcon,
} from "symbols-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

interface PendingActionState {
  questionIndex: number;
  isLastQuestion: boolean;
  canAdvance: boolean;
  isResponding: boolean;
  isComplete: boolean;
}

export type ComposerQueueStatus = "idle" | "queued" | "paused";

interface ComposerPrimaryActionsProps {
  compact: boolean;
  pendingAction: PendingActionState | null;
  isRunning: boolean;
  queueStatus: ComposerQueueStatus;
  showPlanFollowUpPrompt: boolean;
  promptHasText: boolean;
  isSendBusy: boolean;
  sendDisabledReason: string | null;
  isConnecting: boolean;
  isEnvironmentUnavailable: boolean;
  isPreparingWorktree: boolean;
  hasSendableContent: boolean;
  preserveComposerFocusOnPointerDown?: boolean;
  onPreviousPendingQuestion: () => void;
  onInterrupt: () => void;
  onImplementPlanInNewThread: () => void;
}

export const formatPendingPrimaryActionLabel = (input: {
  compact: boolean;
  isLastQuestion: boolean;
  isResponding: boolean;
  questionIndex: number;
}) => {
  if (input.isResponding) return "Submitting...";
  if (input.compact) return input.isLastQuestion ? "Submit" : "Next";
  if (!input.isLastQuestion) return "Next question";
  return input.questionIndex > 0 ? "Submit answers" : "Submit answer";
};

export type ComposerPrimaryActionState = {
  kind: "send" | "queue" | "interrupt" | "busy" | "disabled";
  label: string;
  disabled: boolean;
};

export function resolveComposerPrimaryAction(input: {
  isRunning: boolean;
  queueStatus: ComposerQueueStatus;
  isSendBusy: boolean;
  sendDisabledReason: string | null;
  isConnecting: boolean;
  isEnvironmentUnavailable: boolean;
  isPreparingWorktree: boolean;
  hasSendableContent: boolean;
}): ComposerPrimaryActionState {
  if (input.isEnvironmentUnavailable) {
    return { kind: "disabled", label: "Environment disconnected", disabled: true };
  }
  if (input.sendDisabledReason) {
    return { kind: "disabled", label: input.sendDisabledReason, disabled: true };
  }
  if (input.isConnecting) {
    return { kind: "busy", label: "Connecting", disabled: true };
  }
  if (input.isPreparingWorktree) {
    return { kind: "busy", label: "Preparing worktree", disabled: true };
  }
  if (input.isSendBusy) {
    return { kind: "busy", label: "Sending", disabled: true };
  }
  if (input.isRunning && !input.hasSendableContent) {
    return { kind: "interrupt", label: "Interrupt turn", disabled: false };
  }
  if (input.isRunning || input.queueStatus !== "idle") {
    return {
      kind: "queue",
      label: "Add to queue",
      disabled: !input.hasSendableContent,
    };
  }
  return {
    kind: input.hasSendableContent ? "send" : "disabled",
    label: "Send message",
    disabled: !input.hasSendableContent,
  };
}

function ComposerSpinnerIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      className="motion-safe:animate-spin"
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
  );
}

export function ComposerSendIcon({ className }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      className={className}
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
  );
}

function ComposerStopIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      <rect x="2" y="2" width="8" height="8" rx="1.5" />
    </svg>
  );
}

const preventPointerFocus: PointerEventHandler<HTMLElement> = (event) => {
  event.preventDefault();
};

export const ComposerPrimaryActions = memo(function ComposerPrimaryActions({
  compact,
  pendingAction,
  isRunning,
  queueStatus,
  showPlanFollowUpPrompt,
  promptHasText,
  isSendBusy,
  sendDisabledReason,
  isConnecting,
  isEnvironmentUnavailable,
  isPreparingWorktree,
  hasSendableContent,
  preserveComposerFocusOnPointerDown = false,
  onPreviousPendingQuestion,
  onInterrupt,
  onImplementPlanInNewThread,
}: ComposerPrimaryActionsProps) {
  const pointerFocusProps = preserveComposerFocusOnPointerDown
    ? { onPointerDown: preventPointerFocus }
    : undefined;

  if (pendingAction) {
    return (
      <div className={cn("flex items-center justify-end", compact ? "gap-1.5" : "gap-2")}>
        {pendingAction.questionIndex > 0 ? (
          compact ? (
            <Button
              size="icon-sm"
              variant="outline"
              className="rounded-full"
              {...pointerFocusProps}
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
              aria-label="Previous question"
            >
              <ChevronLeftIcon className="size-2.5" />
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="rounded-full"
              {...pointerFocusProps}
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
            >
              Previous
            </Button>
          )
        ) : null}
        <Button
          type="submit"
          size="sm"
          className={cn("rounded-full", compact ? "px-3" : "px-4")}
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
        </Button>
      </div>
    );
  }

  if (showPlanFollowUpPrompt) {
    const planActionsDisabled =
      isSendBusy || sendDisabledReason !== null || isConnecting || isEnvironmentUnavailable;
    if (promptHasText) {
      return (
        <Button
          type="submit"
          size="sm"
          className={cn("rounded-full", compact ? "h-9 px-3 sm:h-8" : "h-9 px-4 sm:h-8")}
          {...pointerFocusProps}
          disabled={planActionsDisabled}
        >
          {isConnecting || isSendBusy ? "Sending..." : "Refine"}
        </Button>
      );
    }

    return (
      <div data-chat-composer-implement-actions="true" className="flex items-center justify-end">
        <Button
          type="submit"
          size="sm"
          className="h-9 rounded-l-full rounded-r-none px-4 sm:h-8"
          {...pointerFocusProps}
          disabled={planActionsDisabled}
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
                {...pointerFocusProps}
                disabled={planActionsDisabled}
              />
            }
          >
            <ChevronDownIcon className="size-2.5" />
          </MenuTrigger>
          <MenuPopup align="end" side="top">
            <MenuItem disabled={planActionsDisabled} onClick={onImplementPlanInNewThread}>
              Implement in a new thread
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    );
  }

  const action = resolveComposerPrimaryAction({
    isRunning,
    queueStatus,
    isSendBusy,
    sendDisabledReason,
    isConnecting,
    isEnvironmentUnavailable,
    isPreparingWorktree,
    hasSendableContent,
  });
  const canInterrupt = action.kind === "interrupt";

  return (
    <Button
      type={canInterrupt ? "button" : "submit"}
      size="icon"
      variant={canInterrupt ? "destructive-outline" : "default"}
      className="rounded-full"
      {...pointerFocusProps}
      disabled={action.disabled}
      aria-label={action.label}
      title={action.label}
      onClick={canInterrupt ? onInterrupt : undefined}
    >
      {action.kind === "busy" ? (
        <ComposerSpinnerIcon />
      ) : canInterrupt ? (
        <ComposerStopIcon />
      ) : (
        <ComposerSendIcon />
      )}
    </Button>
  );
});
