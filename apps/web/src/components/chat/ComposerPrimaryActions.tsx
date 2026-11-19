import {
  memo,
  useEffect,
  useState,
  type ComponentProps,
  type MouseEventHandler,
  type PointerEventHandler,
  type ReactNode,
} from "react";
import { msg, useGT, useMessages } from "gt-react";
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronLeftIcon,
  CornerUpRightIcon,
  ListPlusIcon,
  Minimize2Icon,
  PlayIcon,
} from "lucide-react";
import type { MessageResolver } from "~/i18n/messages";
import { formatContextWindowTokens } from "~/lib/contextWindow";
import { cn, isMacPlatform } from "~/lib/utils";
import { useShortcutModifierState } from "../../shortcutModifierState";
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
  /** The dictation mic: a slot in the send and stop pill, a quiet icon before the other actions. */
  renderSpeechAction?: ((inPill: boolean) => ReactNode) | undefined;
  onSubmitMessage?: MouseEventHandler<HTMLButtonElement>;
  onResume?: () => void;
  onPreviousPendingQuestion: () => void;
  onInterrupt: () => void;
  /** Set while dictation records: the stop slot finishes it instead of sending. */
  onStopDictation?: (() => void) | undefined;
  stopDictationShortcutLabel?: string | null;
  compactBeforeSendTokens?: number | null;
  keepFullHistory?: boolean;
  onToggleKeepFullHistory?: () => void;
}

const formatPendingPrimaryActionLabel = (
  input: {
    compact: boolean;
    isLastQuestion: boolean;
    isResponding: boolean;
    questionIndex: number;
  },
  resolve: MessageResolver,
) => {
  if (input.isResponding) {
    return resolve(msg("Submitting..."));
  }
  if (input.compact) {
    return input.isLastQuestion
      ? resolve(msg("Submit", { $context: "verb, submits answers" }))
      : resolve(msg("Next", { $context: "button that goes to the next question" }));
  }
  if (!input.isLastQuestion) {
    return resolve(msg("Next question"));
  }
  return input.questionIndex > 0 ? resolve(msg("Submit answers")) : resolve(msg("Submit answer"));
};

const STOP_PENDING_MAX_MS = 10_000;
// The action that takes Stop's place ignores clicks this long, so repeat Stop clicks can't resume.
const STOP_LANDED_CLICK_GUARD_MS = 500;

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
  leading = null,
  onStopDictation,
  stopDictationShortcutLabel = null,
}: {
  stopPhase: StopPhase;
  canOperateThread: boolean;
  insidePendingAction: boolean;
  preserveComposerFocusOnPointerDown: boolean;
  onStopRequested: () => void;
  onInterrupt: () => void;
  /** The dictation mic slot that shares the pill. */
  leading?: ReactNode;
  /** Set while dictation records: the stop slot finishes it instead of interrupting. */
  onStopDictation?: (() => void) | undefined;
  stopDictationShortcutLabel?: string | null;
}) {
  const gt = useGT();
  const isStopDisabled = stopPhase === "pending";
  const stopLabel = onStopDictation
    ? gt("Stop voice input")
    : stopPhase === "pending"
      ? gt("Stopping")
      : gt("Stop generation");
  return (
    <ComposerSendPill className={cn(insidePendingAction && "sm:h-7")}>
      {leading}
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
              onPointerDown={preserveComposerFocusOnPointerDown ? preventPointerFocus : undefined}
              disabled={!onStopDictation && (!canOperateThread || isStopDisabled)}
              onClick={() => {
                if (onStopDictation) {
                  onStopDictation();
                  return;
                }
                if (!canOperateThread || isStopDisabled) return;
                onStopRequested();
                onInterrupt();
              }}
              aria-label={stopLabel}
            />
          }
        >
          <span aria-hidden className="size-2.5 rounded-xs bg-error-foreground" />
        </TooltipTrigger>
        <TooltipPopup>
          {onStopDictation
            ? stopDictationShortcutLabel
              ? gt("Stop voice input ({shortcut})", { shortcut: stopDictationShortcutLabel })
              : stopLabel
            : stopPhase === "pending"
              ? gt("Stopping…")
              : gt("Interrupt", { $context: "verb, stops the running agent" })}
        </TooltipPopup>
      </Tooltip>
    </ComposerSendPill>
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
  renderSpeechAction,
  onSubmitMessage,
  onResume,
  onPreviousPendingQuestion,
  onInterrupt,
  onStopDictation,
  stopDictationShortcutLabel = null,
  compactBeforeSendTokens = null,
  keepFullHistory = false,
  onToggleKeepFullHistory,
}: ComposerPrimaryActionsProps) {
  const gt = useGT();
  const m = useMessages();
  const [stopPhase, setStopPhase] = useStopPhase({ runId, canInterrupt, canOperateThread });
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
  // While dictating it ends the recording; a running turn's stop returns after.
  const stopsDictation = onStopDictation !== undefined && !pendingAction;
  const renderStopGenerationButton = (insidePendingAction: boolean) => (
    <StopGenerationButton
      key="interrupt"
      stopPhase={stopPhase}
      canOperateThread={canOperateThread}
      insidePendingAction={insidePendingAction}
      preserveComposerFocusOnPointerDown={preserveComposerFocusOnPointerDown}
      onStopRequested={() => setStopPhase("pending")}
      onInterrupt={onInterrupt}
      leading={insidePendingAction ? null : renderSpeechAction?.(true)}
      {...(stopsDictation ? { onStopDictation } : {})}
      stopDictationShortcutLabel={stopDictationShortcutLabel}
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
        {renderSpeechAction?.(false)}
        {pendingAction.questionIndex > 0 ? (
          compact ? (
            <Button
              size="icon-sm"
              variant="secondary"
              {...pointerFocusProps}
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
              aria-label={gt("Previous question")}
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
              {gt("Previous", { $context: "button that goes to the previous question" })}
            </Button>
          )
        ) : null}
        {children}
        <MessageActionPill
          type="submit"
          className={cn("h-8 sm:h-7", compact ? "px-3" : "px-4")}
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
          {formatPendingPrimaryActionLabel(
            {
              compact,
              isLastQuestion: pendingAction.isLastQuestion,
              isResponding: pendingAction.isResponding,
              questionIndex: pendingAction.questionIndex,
            },
            m,
          )}
        </MessageActionPill>
        {canInterrupt || stopPhase === "pending" || stopPhase === "timedOut"
          ? renderStopGenerationButton(true)
          : null}
      </div>
    );
  }

  if (
    stopsDictation ||
    ((canInterrupt || stopPhase === "pending" || stopPhase === "timedOut") &&
      !hasSendableContent &&
      !isEditingQueuedMessage)
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
    ? gt("Resume thread")
    : isEditingQueuedMessage
      ? gt("Update queued message")
      : compactsBeforeSend
        ? gt("Compact and send")
        : isQueuing
          ? gt("Queue message")
          : isRunning
            ? gt("Steer message")
            : gt("Submit message");
  const submitStatus = isEnvironmentUnavailable
    ? gt("Environment disconnected")
    : (sendDisabledReason ??
      (isPreparingWorktree
        ? gt("Preparing worktree")
        : isSendBusy
          ? isEditingQueuedMessage
            ? gt("Updating queued message")
            : gt("Submitting message")
          : null));
  const modifier = isMacPlatform(navigator.platform) ? "⌘" : "Ctrl";
  const dispatchTooltip =
    alternateAction === "queue"
      ? alternateShortcutLabel
        ? gt("Click to steer, {modifier}-click or {shortcut} to queue", {
            modifier,
            shortcut: alternateShortcutLabel,
          })
        : gt("Click to steer, {modifier}-click to queue", { modifier })
      : alternateShortcutLabel
        ? gt("Click to queue, {modifier}-click or {shortcut} to steer", {
            modifier,
            shortcut: alternateShortcutLabel,
          })
        : gt("Click to queue, {modifier}-click to steer", { modifier });
  const submitTooltip =
    submitStatus ??
    (compactsBeforeSend
      ? gt("Summarize {tokens} tokens of history, then send", { tokens: compactTokens })
      : isRunning && !isEditingQueuedMessage && canSteer
        ? dispatchTooltip
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
      {isSendBusy ? (
        <Spinner size="sm" aria-hidden="true" />
      ) : showResume ? (
        <PlayIcon className="size-4 fill-current" aria-hidden="true" />
      ) : isEditingQueuedMessage ? (
        <CheckIcon className="size-3.5" aria-hidden="true" />
      ) : isQueuing ? (
        <>
          <ListPlusIcon className="size-3.5" aria-hidden="true" />
          {gt("Queue", { $context: "verb, queues the message" })}
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
      {renderSpeechAction?.(true)}
      <Tooltip>
        {/* A span trigger keeps the tooltip reachable while send is disabled. */}
        <TooltipTrigger render={<span className="flex h-full" />}>{sendButton}</TooltipTrigger>
        <TooltipPopup>{submitTooltip}</TooltipPopup>
      </Tooltip>
    </ComposerSendPill>
  );
  if (compactTokens === null) {
    return withStopButton(
      <>
        {children}
        {submit}
      </>,
    );
  }
  const compactTone = keepFullHistory ? "text-muted-foreground" : "text-warning-foreground";

  return withStopButton(
    <div data-chat-composer-compact-send="true" className="flex items-center gap-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="action"
              variant="pill"
              {...pointerFocusProps}
              aria-pressed={!keepFullHistory}
              aria-label={gt("Compact {tokens} tokens of history before sending", {
                tokens: compactTokens,
              })}
              disabled={!canOperateThread}
              onClick={onToggleKeepFullHistory}
            />
          }
        >
          <Minimize2Icon aria-hidden="true" className={compactTone} />
          <span className={cn("@max-[480px]/composer-surface:hidden", compactTone)}>
            {keepFullHistory
              ? gt("Full", { $context: "keep full history instead of compacting" })
              : gt("Compact", { $context: "verb, compact history before sending" })}
          </span>
          <span className={cn("tabular-nums", compactTone)}>{compactTokens}</span>
        </TooltipTrigger>
        <TooltipPopup>
          <div>
            {keepFullHistory
              ? gt("Next send keeps all {tokens} tokens.", { tokens: compactTokens })
              : gt("Next send compacts {tokens} tokens first.", { tokens: compactTokens })}
          </div>
          <div>
            {keepFullHistory ? gt("Click to compact first") : gt("Click to keep full history")}
          </div>
        </TooltipPopup>
      </Tooltip>
      {children}
      {submit}
    </div>,
  );
});

/**
 * The mic + send pill. Send and stop render inside it, and dictation's mic
 * joins as a sibling slot before them, so the pill keeps one shape in every state.
 */
export function ComposerSendPill({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <span data-composer-send-pill="true" className={cn(COMPOSER_PILL_CLASS_NAME, className)}>
      {children}
    </span>
  );
}

// A 32px button slot of the send pill for the dictation mic and the collapsed row's send.
export const COMPOSER_PILL_SLOT_BUTTON_CLASS_NAME =
  "relative isolate flex h-full w-8 items-center justify-center overflow-hidden rounded-md text-foreground outline-none transition-colors duration-150 enabled:cursor-pointer enabled:hover:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-64 [&_svg]:pointer-events-none";
export const COMPOSER_PILL_SLOT_BUTTON_UNAVAILABLE_CLASS_NAME = cn(
  COMPOSER_PILL_SLOT_BUTTON_CLASS_NAME,
  "opacity-64 enabled:cursor-default enabled:hover:bg-transparent",
);
