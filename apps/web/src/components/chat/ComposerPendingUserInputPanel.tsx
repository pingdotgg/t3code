import { type RuntimeRequestId, type ScopedThreadRef } from "@t3tools/contracts";
import { markdownProseDirection, textDirection } from "~/textDirection";
import { memo, use, useEffect, useEffectEvent, useRef, useState } from "react";
import { BackgroundThreadContext } from "./backgroundThread";
import { useStableCallback } from "~/hooks/useStableCallback";
import { type PendingUserInput } from "../../session-logic";
import type { PendingUserInputDraftAnswer } from "@t3tools/client-runtime/state/pending-user-input";
import { derivePendingUserInputProgress } from "../../pendingUserInput";
import { CheckIcon, MessageCircleQuestionMarkIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { cn } from "~/lib/utils";
import { isInSideChatPane } from "~/lib/sideChatPane";
import { useLayoutPaneFocusedRef } from "../../layout/layoutPaneContext";
import { ComposerBanner } from "./ComposerBanner";
import ChatMarkdown from "../ChatMarkdown";
import { ComposerRequestCard, useRequestCardEnterShortcut } from "./ComposerRequestCard";

/** Enablement of the card's Answer / Next action, derived by the composer. */
export interface PendingUserInputPrimaryAction {
  questionIndex: number;
  isLastQuestion: boolean;
  canAdvance: boolean;
  isResponding: boolean;
  isComplete: boolean;
}

interface PendingUserInputPanelProps {
  actionsInComposer?: boolean;
  pendingUserInputs: PendingUserInput[];
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
  disabled?: boolean;
  respondingRequestIds: RuntimeRequestId[];
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionValue: string) => void;
  onAdvance: () => void;
  onDismiss: (requestId: RuntimeRequestId) => void;
  /** Provider display name for the header, such as "Codex". */
  providerLabel?: string | null;
  /** Answer / Next and Previous live in the card when these are set. */
  primaryAction?: PendingUserInputPrimaryAction | null;
  onSubmit?: () => void;
  onPrevious?: () => void;
  /** "Let me write an answer": the composer is the answer field, so this focuses it. */
  onWriteAnswer?: () => void;
}

export const ComposerPendingUserInputPanel = memo(function ComposerPendingUserInputPanel({
  actionsInComposer = false,
  pendingUserInputs,
  cwd,
  threadRef,
  disabled = false,
  respondingRequestIds,
  answers,
  questionIndex,
  onToggleOption,
  onAdvance,
  onDismiss,
  providerLabel = null,
  primaryAction = null,
  onSubmit,
  onPrevious,
  onWriteAnswer,
}: PendingUserInputPanelProps) {
  if (pendingUserInputs.length === 0) return null;
  const activePrompt = pendingUserInputs[0];
  if (!activePrompt) return null;

  return (
    <ComposerPendingUserInputCard
      key={activePrompt.requestId}
      actionsInComposer={actionsInComposer}
      prompt={activePrompt}
      cwd={cwd}
      threadRef={threadRef}
      disabled={disabled}
      isResponding={respondingRequestIds.includes(activePrompt.requestId)}
      answers={answers}
      questionIndex={questionIndex}
      onToggleOption={onToggleOption}
      onAdvance={onAdvance}
      onDismiss={onDismiss}
      providerLabel={providerLabel}
      primaryAction={primaryAction}
      onSubmit={onSubmit}
      onPrevious={onPrevious}
      onWriteAnswer={onWriteAnswer}
    />
  );
});

const ComposerPendingUserInputCard = memo(function ComposerPendingUserInputCard({
  actionsInComposer,
  prompt,
  cwd,
  threadRef,
  disabled,
  isResponding,
  answers,
  questionIndex,
  onToggleOption,
  onAdvance,
  onDismiss,
  providerLabel,
  primaryAction,
  onSubmit,
  onPrevious,
  onWriteAnswer,
}: {
  actionsInComposer: boolean;
  prompt: PendingUserInput;
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
  disabled: boolean;
  isResponding: boolean;
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionValue: string) => void;
  onAdvance: () => void;
  onDismiss: (requestId: RuntimeRequestId) => void;
  providerLabel: string | null;
  primaryAction: PendingUserInputPrimaryAction | null;
  onSubmit: (() => void) | undefined;
  onPrevious: (() => void) | undefined;
  onWriteAnswer: (() => void) | undefined;
}) {
  // Message-mode requests remain answerable after their provider turn ends.
  const canRespond = prompt.responseCapability !== "not_resumable";
  const responseDisabled = disabled || isResponding || !canRespond;
  const autoAdvanceTimerRef = useRef<number | null>(null);
  const advance = useStableCallback(onAdvance);
  const [optimisticSingleSelect, setOptimisticSingleSelect] = useState<{
    questionId: string;
    optionValue: string;
  } | null>(null);
  const [collapsedQuestionId, setCollapsedQuestionId] = useState<string | null>(null);
  // Keep question identity stable for its shortcut listener.
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);
  const activeQuestion = progress.activeQuestion;
  const customAnswerActive = progress.customAnswer.trim().length > 0;
  // Read before later hooks to preserve the question's compiler cache.
  const draftSelectedOptions = activeQuestion?.options.map(
    (option) =>
      !customAnswerActive && progress.selectedOptionValues.includes(option.value ?? option.label),
  );
  const isCollapsed = collapsedQuestionId !== null && collapsedQuestionId === activeQuestion?.id;

  if (
    optimisticSingleSelect &&
    activeQuestion &&
    !activeQuestion.multiSelect &&
    (optimisticSingleSelect.questionId !== activeQuestion.id ||
      (!customAnswerActive &&
        progress.selectedOptionValues.includes(optimisticSingleSelect.optionValue)))
  ) {
    setOptimisticSingleSelect(null);
  }

  const canWriteAnswer = activeQuestion?.allowCustomAnswer !== false && onWriteAnswer !== undefined;
  const primaryDisabled =
    !primaryAction ||
    primaryAction.isResponding ||
    (primaryAction.isLastQuestion ? !primaryAction.isComplete : !primaryAction.canAdvance);
  useRequestCardEnterShortcut(
    onSubmit && !primaryDisabled && !responseDisabled && !isCollapsed ? onSubmit : null,
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the auto-advance timer when the question changes, input is disabled, or the panel unmounts
  useEffect(() => {
    const clearAutoAdvance = () => {
      if (autoAdvanceTimerRef.current !== null) {
        window.clearTimeout(autoAdvanceTimerRef.current);
        autoAdvanceTimerRef.current = null;
      }
    };
    if (disabled || activeQuestion?.id === undefined) clearAutoAdvance();
    return clearAutoAdvance;
  }, [activeQuestion?.id, disabled]);

  const handleOptionSelection = (questionId: string, optionValue: string) => {
    if (disabled || isResponding) return;
    if (activeQuestion?.multiSelect) {
      onToggleOption(questionId, optionValue);
      return;
    }
    setOptimisticSingleSelect({ questionId, optionValue });
    onToggleOption(questionId, optionValue);
    if (autoAdvanceTimerRef.current !== null) {
      window.clearTimeout(autoAdvanceTimerRef.current);
    }
    autoAdvanceTimerRef.current = window.setTimeout(() => {
      autoAdvanceTimerRef.current = null;
      advance();
    }, 200);
  };

  const selectOptionFromShortcut = useEffectEvent(handleOptionSelection);
  const backgroundThread = use(BackgroundThreadContext);
  const writeAnswerFromShortcut = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (!canWriteAnswer) return;
    event.preventDefault();
    onWriteAnswer?.();
  });

  // Only the layout-focused pane's prompt answers number-key shortcuts.
  const paneFocusedRef = useLayoutPaneFocusedRef();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes a document keydown listener for digit shortcuts while a question is answerable
  useEffect(() => {
    if (!activeQuestion || responseDisabled || isCollapsed || backgroundThread) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (!paneFocusedRef.current) return;
      const target = event.target;
      if (isInSideChatPane(target)) return;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return;
      }
      if (
        target instanceof HTMLElement &&
        target.closest('[contenteditable]:not([contenteditable="false"])')
      ) {
        return;
      }
      const digit = Number.parseInt(event.key, 10);
      if (Number.isNaN(digit) || digit < 1 || digit > 9) return;
      const optionIndex = digit - 1;
      if (optionIndex === activeQuestion.options.length) {
        writeAnswerFromShortcut(event);
        return;
      }
      if (optionIndex >= activeQuestion.options.length) return;
      const option = activeQuestion.options[optionIndex];
      if (!option) return;
      event.preventDefault();
      selectOptionFromShortcut(activeQuestion.id, option.value ?? option.label);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeQuestion, backgroundThread, isCollapsed, paneFocusedRef, responseDisabled]);

  if (!activeQuestion) {
    return null;
  }

  const promptDirection = markdownProseDirection(
    prompt.questions
      .flatMap((question) => [
        question.header,
        question.question,
        ...question.options.flatMap((option) => [option.label, option.description ?? ""]),
      ])
      .join(" "),
  );
  const questionTextAlign = promptDirection === "rtl" ? "text-right" : "text-left";
  const writeOptionKey =
    activeQuestion.options.length < 9 ? activeQuestion.options.length + 1 : null;
  const hint = customAnswerActive
    ? "Your answer is ready to submit."
    : activeQuestion.multiSelect
      ? "Select one or more options."
      : "Select one option.";
  const primaryLabel = primaryAction?.isResponding
    ? "Submitting…"
    : primaryAction && !primaryAction.isLastQuestion
      ? "Next"
      : prompt.questions.length > 1
        ? "Submit answers"
        : "Answer";

  return (
    <Collapsible
      dir={promptDirection}
      open={!isCollapsed}
      onOpenChange={(open) => {
        setCollapsedQuestionId(open ? null : activeQuestion.id);
      }}
      render={<ComposerRequestCard.Root data-chat-composer-request-card="question" />}
    >
      <ComposerRequestCard.Header
        render={
          <CollapsibleTrigger
            render={<button type="button" />}
            title={
              isCollapsed
                ? "Show the question and its options"
                : "Hide the question and its options"
            }
            data-pending-user-input-toggle={isCollapsed ? "collapsed" : "expanded"}
          />
        }
        icon={<MessageCircleQuestionMarkIcon className="text-ring" />}
        title="Question"
        sub={
          isCollapsed ? (
            <span
              className={questionTextAlign}
              dir={markdownProseDirection(activeQuestion.question)}
            >
              {activeQuestion.question}
            </span>
          ) : (
            `${providerLabel || "The agent"} needs an answer`
          )
        }
        trailing={
          <>
            {prompt.questions.length > 1 ? (
              <ComposerRequestCard.Counter
                index={questionIndex + 1}
                total={prompt.questions.length}
              />
            ) : null}
            <ComposerBanner.ToggleIcon expanded={!isCollapsed} />
            {prompt.dismissible ? (
              <ComposerBanner.Dismiss
                render={<span role="button" tabIndex={0} />}
                aria-label="Dismiss question without answering"
                title="Dismiss question without answering"
                disabled={isResponding}
                data-pending-user-input-dismiss
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onDismiss(prompt.requestId);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  event.stopPropagation();
                  onDismiss(prompt.requestId);
                }}
              />
            ) : null}
          </>
        }
      />
      <CollapsiblePanel>
        <ComposerBanner.Scroll>
          <div className="flex min-w-0 flex-col gap-1 wrap-anywhere">
            <ComposerRequestCard.Body>
              <ChatMarkdown
                text={activeQuestion.question}
                cwd={cwd}
                threadRef={threadRef}
                className={cn("text-foreground", questionTextAlign)}
              />
            </ComposerRequestCard.Body>
            <ComposerRequestCard.Well density="options">
              {activeQuestion.options.map((option, index) => {
                const optionValue = option.value ?? option.label;
                const isOptimisticallySelected =
                  optimisticSingleSelect?.questionId === activeQuestion.id &&
                  optimisticSingleSelect.optionValue === optionValue;
                const isSelected =
                  isOptimisticallySelected || draftSelectedOptions?.[index] === true;
                return (
                  <QuestionOptionRow
                    textAlign={questionTextAlign}
                    key={`${activeQuestion.id}:${optionValue}`}
                    label={option.label}
                    description={
                      option.description && option.description !== option.label
                        ? option.description
                        : null
                    }
                    multiSelect={activeQuestion.multiSelect === true}
                    selected={isSelected}
                    shortcutKey={index < 9 ? index + 1 : null}
                    disabled={disabled || isResponding}
                    onSelect={() => handleOptionSelection(activeQuestion.id, optionValue)}
                  />
                );
              })}
              {canWriteAnswer ? (
                <QuestionOptionRow
                  textAlign={questionTextAlign}
                  label="Let me write an answer"
                  description={customAnswerActive ? progress.customAnswer.trim() : null}
                  multiSelect={activeQuestion.multiSelect === true}
                  selected={customAnswerActive}
                  shortcutKey={writeOptionKey}
                  disabled={disabled || isResponding}
                  onSelect={() => onWriteAnswer?.()}
                />
              ) : null}
            </ComposerRequestCard.Well>
          </div>
        </ComposerBanner.Scroll>
        <ComposerRequestCard.Footer>
          <span className="min-w-0 truncate text-dim-foreground">{hint}</span>
          <ComposerRequestCard.Spacer />
          {prompt.dismissible ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={isResponding}
              onClick={() => onDismiss(prompt.requestId)}
            >
              Skip
            </Button>
          ) : null}
          {!actionsInComposer && onPrevious && questionIndex > 0 ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={primaryAction?.isResponding ?? isResponding}
              onClick={onPrevious}
            >
              Previous
            </Button>
          ) : null}
          {!actionsInComposer && onSubmit ? (
            <Button
              size="sm"
              variant="default"
              disabled={primaryDisabled || responseDisabled}
              aria-keyshortcuts="Enter"
              onClick={onSubmit}
            >
              {primaryLabel}
              <ComposerRequestCard.EnterKey />
            </Button>
          ) : null}
        </ComposerRequestCard.Footer>
      </CollapsiblePanel>
    </Collapsible>
  );
});

function QuestionOptionRow({
  textAlign,
  label,
  description,
  multiSelect,
  selected,
  shortcutKey,
  disabled,
  onSelect,
}: {
  textAlign: "text-left" | "text-right";
  label: string;
  description: string | null;
  multiSelect: boolean;
  selected: boolean;
  shortcutKey: number | null;
  disabled: boolean;
  onSelect: () => void;
}) {
  const className = cn(
    textAlign,
    "group flex w-full items-center gap-2.5 rounded-row px-2.5 py-2 text-foreground outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
    selected ? "bg-selection-neutral" : "bg-transparent hover:surface-ghost-hover",
    disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
  );
  return (
    <button
      type="button"
      role={multiSelect ? "checkbox" : "radio"}
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={className}
    >
      {shortcutKey !== null ? (
        <kbd className="flex size-5 shrink-0 items-center justify-center rounded-kbd surface-raised text-micro text-muted-foreground tabular-nums">
          {shortcutKey}
        </kbd>
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-body" dir={textDirection(label)}>
          {label}
        </span>
        {description ? (
          <span
            className="line-clamp-2 text-caption text-dim-foreground"
            dir={textDirection(description)}
          >
            {description}
          </span>
        ) : null}
      </span>
      {multiSelect ? (
        <span
          aria-hidden
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-kbd",
            selected ? "surface-gloss-on text-primary-foreground" : "surface-well",
          )}
        >
          {selected ? <CheckIcon className="size-3" /> : null}
        </span>
      ) : (
        <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
          {selected ? <CheckIcon className="size-3.5" /> : null}
        </span>
      )}
    </button>
  );
}
