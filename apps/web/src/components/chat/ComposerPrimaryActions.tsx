import {
  memo,
  type ComponentProps,
  type MouseEventHandler,
  type PointerEventHandler,
  type ReactNode,
} from "react";
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronDownIcon,
  CornerUpRightIcon,
  ListPlusIcon,
  Minimize2Icon,
  PlayIcon,
} from "lucide-react";
import { formatContextWindowTokens } from "~/lib/contextWindow";
import { cn, isMacPlatform } from "~/lib/utils";
import { useShortcutModifierState } from "../../shortcutModifierState";
import { Group, GroupSeparator } from "../ui/group";
import { Menu, MenuTrigger, MenuItem, MenuPopup } from "../ui/menu";
import { composerFloatingLayerProps } from "./composerEventScope";
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
  compact: boolean;
  canOperateThread: boolean;
  pendingAction: PendingActionState | null;
  isRunning: boolean;
  canInterrupt: boolean;
  followUpBehavior?: "queue" | "steer";
  canSteer?: boolean;
  alternateShortcutLabel?: string | null;
  showPlanFollowUpPrompt: boolean;
  onImplementPlanInNewThread?: (() => void) | undefined;
  promptHasText: boolean;
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

// The pending-question Submit action shares the send button's message-action pill,
// so it is a composer-owned button rather than a restyled Button.
const messageActionPillClassName =
  "relative isolate inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-control before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-[inherit] before:surface-lit font-medium text-base text-primary-foreground outline-none hover:before:surface-lit-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 disabled:shadow-none sm:text-sm";

// The mic + send pill: light gray in light mode, black in dark mode.
const COMPOSER_PILL_CLASS_NAME =
  "relative isolate inline-flex h-8 shrink-0 items-center rounded-lg surface-pill";

// One 32px button slot inside the pill (send, stop, and later the mic), concentric
// with the pill inside its 1px rim.
const COMPOSER_PILL_SLOT_CLASS_NAME =
  "relative isolate flex h-full shrink-0 cursor-pointer items-center justify-center rounded-item outline-none transition-colors duration-150 hover:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&_svg]:pointer-events-none";

/** A labeled primary action on the message-action pill; callers add height, padding and split edges. */
function MessageActionPill({ className, type = "button", ...props }: ComponentProps<"button">) {
  return <button type={type} className={cn(messageActionPillClassName, className)} {...props} />;
}

const preventPointerFocus: PointerEventHandler<HTMLElement> = (event) => {
  event.preventDefault();
};

export const ComposerPrimaryActions = memo(function ComposerPrimaryActions({
  compact,
  canOperateThread,
  pendingAction,
  isRunning,
  canInterrupt,
  followUpBehavior = "steer",
  canSteer = true,
  alternateShortcutLabel = null,
  showPlanFollowUpPrompt,
  onImplementPlanInNewThread,
  promptHasText,
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
  keepFullHistory = false,
  onToggleKeepFullHistory,
}: ComposerPrimaryActionsProps) {
  const pointerFocusProps = preserveComposerFocusOnPointerDown
    ? { onPointerDown: preventPointerFocus }
    : undefined;
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

  // The stop square sits in the same pill as send, so the pill never changes shape.
  const renderStopGenerationButton = (insidePendingAction: boolean) => (
    <ComposerSendPill key="interrupt" className={cn(insidePendingAction && "sm:h-7")}>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className={cn(
                COMPOSER_PILL_SLOT_CLASS_NAME,
                "w-8",
                insidePendingAction && "sm:w-6.5",
              )}
              {...pointerFocusProps}
              disabled={!canOperateThread}
              onClick={() => {
                if (canOperateThread) onInterrupt();
              }}
              aria-label="Stop generation"
            />
          }
        >
          <span aria-hidden className="size-2.5 rounded-xs bg-error-foreground" />
        </TooltipTrigger>
        <TooltipPopup>Interrupt</TooltipPopup>
      </Tooltip>
    </ComposerSendPill>
  );

  if (pendingAction) {
    return (
      <div className={cn("flex items-center justify-end", compact ? "gap-1.5" : "gap-2")}>
        {canInterrupt ? renderStopGenerationButton(true) : null}
        {pendingAction.questionIndex > 0 ? (
          compact ? (
            <Button
              size="icon-sm"
              variant="secondary"
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
              variant="secondary"
              {...pointerFocusProps}
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
            >
              Previous
            </Button>
          )
        ) : null}
        <MessageActionPill
          type="submit"
          className={cn("h-8 sm:h-7", compact ? "px-3" : "px-4")}
          {...pointerFocusProps}
          disabled={
            !canOperateThread ||
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
        </MessageActionPill>
      </div>
    );
  }

  if (canInterrupt && !hasSendableContent && !isEditingQueuedMessage) {
    return renderStopGenerationButton(false);
  }

  if (showPlanFollowUpPrompt && onImplementPlanInNewThread) {
    return (
      <Group data-chat-composer-implement-actions="true">
        <Button
          type="submit"
          size="sm"
          variant="default"
          disabled={isSendBusy || isSendDisabled || isEnvironmentUnavailable}
        >
          {isSendBusy ? "Sending…" : promptHasText ? "Refine" : "Implement"}
        </Button>
        <GroupSeparator />
        <Menu>
          <MenuTrigger
            disabled={isSendBusy || isSendDisabled || isEnvironmentUnavailable}
            render={<Button size="icon-sm" variant="default" aria-label="Implementation actions" />}
          >
            <ChevronDownIcon />
          </MenuTrigger>
          <MenuPopup side="top" align="end" {...composerFloatingLayerProps}>
            <MenuItem onClick={onImplementPlanInNewThread}>Implement in a new thread</MenuItem>
          </MenuPopup>
        </Menu>
      </Group>
    );
  }
  const showResume = canResume && !hasSendableContent && !isEditingQueuedMessage;

  const compactTokens =
    compactBeforeSendTokens !== null && !showResume && !isEditingQueuedMessage
      ? formatContextWindowTokens(compactBeforeSendTokens)
      : null;
  const compactsBeforeSend = compactTokens !== null && !keepFullHistory;

  // An empty composer builds the plan from its card; text here refines it.
  const refinesPlan = showPlanFollowUpPrompt && promptHasText;
  const submitLabel = showResume
    ? "Resume thread"
    : isEditingQueuedMessage
      ? "Update queued message"
      : refinesPlan
        ? "Refine plan"
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

  const showQueueLabel = isQueuing && !isSendBusy;
  const sendButton = (
    <button
      type={showResume ? "button" : "submit"}
      className={cn(
        "relative isolate flex h-full items-center justify-center gap-1 overflow-hidden rounded-md text-foreground transition-colors duration-150 enabled:cursor-pointer enabled:hover:bg-foreground/8 disabled:pointer-events-none disabled:opacity-64 [&_svg]:pointer-events-none",
        showQueueLabel ? "ps-1.5 pe-2.5 text-label" : "w-8",
      )}
      {...pointerFocusProps}
      onClick={showResume ? onResume : onSubmitMessage}
      disabled={
        isSendBusy ||
        isSendDisabled ||
        isEnvironmentUnavailable ||
        (!hasSendableContent && !showResume)
      }
      aria-label={submitStatus ?? submitLabel}
    >
      {isSendBusy ? (
        <Spinner size="sm" aria-hidden="true" />
      ) : showResume ? (
        <PlayIcon className="size-4 fill-current" aria-hidden="true" />
      ) : isEditingQueuedMessage ? (
        <CheckIcon className="size-3.5" aria-hidden="true" />
      ) : isQueuing ? (
        <>
          <ListPlusIcon className="size-3.5" aria-hidden="true" />
          Queue
        </>
      ) : isRunning ? (
        <CornerUpRightIcon className="size-3.5" aria-hidden="true" />
      ) : (
        <ArrowUpIcon className="size-3.5" aria-hidden="true" />
      )}
    </button>
  );

  const submit = (
    <ComposerSendPill>
      <Tooltip>
        {/* A span trigger keeps the tooltip reachable while send is disabled. */}
        <TooltipTrigger render={<span className="flex h-full" />}>{sendButton}</TooltipTrigger>
        <TooltipPopup>{submitTooltip}</TooltipPopup>
      </Tooltip>
    </ComposerSendPill>
  );
  if (compactTokens === null) return submit;

  return (
    <div data-chat-composer-compact-send="true" className="flex items-center gap-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="xs"
              variant={keepFullHistory ? "ghost-muted" : "warning-outline"}
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
            {keepFullHistory ? "Full" : "Compact"}
          </span>
          <span className="tabular-nums">{compactTokens}</span>
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
      {submit}
    </div>
  );
});

/**
 * The mic + send pill. Send and stop render inside it, and dictation's mic
 * joins as a sibling slot before them, so the pill keeps one shape in every state.
 */
function ComposerSendPill({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span data-composer-send-pill="true" className={cn(COMPOSER_PILL_CLASS_NAME, className)}>
      {children}
    </span>
  );
}
