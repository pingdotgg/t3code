import { type RuntimeRequestId, type ScopedThreadRef } from "@t3tools/contracts";
import { markdownProseDirection, textDirection } from "~/textDirection";
import { useGT } from "gt-react";
import { memo, use, useEffect, useEffectEvent, useRef, useState, type ComponentProps } from "react";
import { BackgroundThreadContext } from "./backgroundThread";
import { useStableCallback } from "~/hooks/useStableCallback";
import { type PendingUserInput } from "../../session-logic";
import type { PendingUserInputDraftAnswer } from "@t3tools/client-runtime/state/pending-user-input";
import { derivePendingUserInputProgress } from "../../pendingUserInput";
import { CheckboxMark } from "../ui/checkbox";
import { Kbd } from "../ui/kbd";
import { cn } from "~/lib/utils";
import { isInSideChatPane } from "~/lib/sideChatPane";
import { ComposerBanner } from "./ComposerBanner";
import ChatMarkdown from "../ChatMarkdown";
import { ComposerPendingUserInputContext } from "./ComposerPendingUserInputContext";
import { messageActionPillClassName } from "./ComposerPrimaryActions";
import { splitRecommendedLabel } from "./pendingUserInputContext.logic";

/** What the panel's bottom row needs from the composer: the footer no longer holds these buttons. */
export interface PendingUserInputActions {
  isLastQuestion: boolean;
  /** The answer is enough to go on (or, on the last question, to send). */
  ready: boolean;
  /** Blocked for a reason outside the answer: offline, preparing a file, already sending. */
  disabled: boolean;
  /** Dictation is running; Send finishes it and submits. */
  voiceInputActive: boolean;
  onPrevious: () => void;
}

interface PendingUserInputPanelProps {
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
  actions?: PendingUserInputActions | undefined;
}

export const ComposerPendingUserInputPanel = memo(function ComposerPendingUserInputPanel({
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
  actions,
}: PendingUserInputPanelProps) {
  if (pendingUserInputs.length === 0) return null;
  const activePrompt = pendingUserInputs[0];
  if (!activePrompt) return null;

  return (
    <ComposerPendingUserInputCard
      key={activePrompt.requestId}
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
      actions={actions}
    />
  );
});

const ComposerPendingUserInputCard = memo(function ComposerPendingUserInputCard({
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
  actions,
}: {
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
  actions: PendingUserInputActions | undefined;
}) {
  const gt = useGT();
  // Message-mode requests remain answerable after their provider turn ends.
  const canRespond = prompt.responseCapability !== "not_resumable";
  const responseDisabled = disabled || isResponding || !canRespond;
  const autoAdvanceTimerRef = useRef<number | null>(null);
  const advance = useStableCallback(onAdvance);
  const [optimisticSingleSelect, setOptimisticSingleSelect] = useState<{
    questionId: string;
    optionValue: string;
  } | null>(null);
  // Keep question identity stable for its shortcut listener.
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);
  const activeQuestion = progress.activeQuestion;
  const customAnswerActive = progress.customAnswer.trim().length > 0;
  // Read before later hooks to preserve the question's compiler cache.
  const draftSelectedOptions = activeQuestion?.options.map(
    (option) =>
      !customAnswerActive && progress.selectedOptionValues.includes(option.value ?? option.label),
  );

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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes a document keydown listener for digit shortcuts while a question is answerable
  useEffect(() => {
    if (!activeQuestion || responseDisabled || backgroundThread) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (isInSideChatPane(target)) return;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return;
      }
      if (
        target instanceof HTMLElement &&
        target.closest(
          'select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [aria-modal="true"], [role="menu"], [role="combobox"], [data-slot$="popup"]',
        )
      ) {
        return;
      }
      const digit = Number.parseInt(event.key, 10);
      if (Number.isNaN(digit) || digit < 1 || digit > 9) return;
      const optionIndex = digit - 1;
      if (optionIndex >= activeQuestion.options.length) return;
      const option = activeQuestion.options[optionIndex];
      if (!option) return;
      event.preventDefault();
      selectOptionFromShortcut(activeQuestion.id, option.value ?? option.label);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeQuestion, backgroundThread, responseDisabled]);

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

  const multiSelect = activeQuestion.multiSelect === true;
  const autoAdvancing = !multiSelect && optimisticSingleSelect !== null;
  const showPrimary =
    actions !== undefined &&
    !autoAdvancing &&
    (actions.voiceInputActive || actions.ready || (!actions.isLastQuestion && multiSelect));
  const primaryDisabled =
    actions !== undefined && (actions.disabled || (!actions.voiceInputActive && !actions.ready));
  const total = prompt.questions.length;
  const lastContextMessageId = prompt.contextMessageIds?.at(-1);

  return (
    <div dir={promptDirection} className="flex flex-col px-1 pt-3 pb-1" data-pending-user-input>
      {/* One content column: the question, context and progress start 12px inside the option
          highlights (8px from the panel edge); the last action ends 8px from right and bottom. */}
      <ComposerBanner.Scroll>
        <div className="flex flex-col gap-2 pb-1 wrap-anywhere">
          <div className="px-3">
            <ChatMarkdown
              text={activeQuestion.question}
              cwd={cwd}
              threadRef={threadRef}
              lineBreaks
              className={cn("text-foreground", questionTextAlign)}
            />
          </div>
          <div className="px-3 empty:hidden">
            <ComposerPendingUserInputContext
              threadRef={threadRef}
              messageId={lastContextMessageId}
              cwd={cwd}
            />
          </div>
          <div className="mt-1 flex flex-col gap-0.5" role={multiSelect ? "group" : "radiogroup"}>
            {activeQuestion.options.map((option, index) => {
              const optionValue = option.value ?? option.label;
              const isOptimisticallySelected =
                optimisticSingleSelect?.questionId === activeQuestion.id &&
                optimisticSingleSelect.optionValue === optionValue;
              const isSelected = isOptimisticallySelected || draftSelectedOptions?.[index] === true;
              const { text: optionTitle, recommended } = splitRecommendedLabel(option.label);
              return (
                <div key={`${activeQuestion.id}:${optionValue}`}>
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    disabled={disabled || isResponding}
                    onClick={() => {
                      handleOptionSelection(activeQuestion.id, optionValue);
                    }}
                    className={cn(
                      questionTextAlign,
                      "group flex w-full flex-col items-stretch gap-1.5 rounded-xl bg-transparent px-3 py-3.5 outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      isSelected ? "bg-(--shell-highlight)" : "hover:bg-foreground/4",
                      (disabled || isResponding) && "cursor-not-allowed opacity-50",
                      !disabled && !isResponding && "cursor-pointer",
                    )}
                  >
                    {recommended ? (
                      // On its own line above the title, so the mark lines up with the title.
                      <span className="flex ps-6.5">
                        <span className="rounded-full bg-primary/15 px-2 py-px text-xs font-medium text-primary">
                          {gt("Recommended")}
                        </span>
                      </span>
                    ) : null}
                    <span className="flex items-start gap-2.5">
                      <span className="pointer-events-none flex h-5 shrink-0 items-center">
                        {multiSelect ? (
                          <CheckboxMark checked={isSelected} variant="contrast" />
                        ) : (
                          <OptionRadio checked={isSelected} />
                        )}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-1">
                        <span
                          className="text-sm leading-5 font-medium text-foreground"
                          dir={textDirection(optionTitle)}
                        >
                          {optionTitle}
                        </span>
                        {option.description && option.description !== option.label ? (
                          <span
                            className="text-ui leading-4 text-muted-foreground"
                            dir={textDirection(option.description)}
                          >
                            {option.description}
                          </span>
                        ) : null}
                      </span>
                      {index < 9 ? (
                        <span className="flex h-5 shrink-0 items-center">
                          <Kbd>{index + 1}</Kbd>
                        </span>
                      ) : null}
                    </span>
                  </button>
                  {option.preview ? (
                    <ChatMarkdown
                      text={option.preview}
                      cwd={cwd}
                      threadRef={threadRef}
                      lineBreaks
                      className="ps-9.5 pe-3 pb-1.5 text-xs text-foreground/70"
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </ComposerBanner.Scroll>
      {actions ? (
        <div className="mt-2 flex min-h-8 items-center gap-4" data-pending-user-input-actions>
          {total > 1 ? (
            <span className="ps-3 text-xs text-muted-foreground tabular-nums">
              {gt("{current} of {total}", { current: questionIndex + 1, total })}
            </span>
          ) : null}
          <span className="flex-1" />
          {prompt.dismissible ? (
            <TextAction
              last={questionIndex === 0 && !showPrimary}
              disabled={isResponding}
              data-pending-user-input-dismiss
              onClick={() => onDismiss(prompt.requestId)}
            >
              {gt("Skip")}
            </TextAction>
          ) : null}
          {questionIndex > 0 ? (
            <TextAction last={!showPrimary} disabled={isResponding} onClick={actions.onPrevious}>
              {gt("Back")}
            </TextAction>
          ) : null}
          {showPrimary ? (
            <button
              type="submit"
              className={cn(messageActionPillClassName, "h-8 px-4 sm:h-8")}
              disabled={primaryDisabled}
            >
              {actions.isLastQuestion
                ? isResponding
                  ? gt("Submitting...")
                  : gt("Send")
                : gt("Next", { $context: "button that goes to the next question" })}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

/** A quiet text button. When it is the last action it ends in line with the question text, not at the pill edge. */
function TextAction({
  last,
  className,
  ...props
}: Omit<ComponentProps<"button">, "type"> & { last: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        "cursor-pointer text-sm font-medium text-secondary-label outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50",
        last && "me-3",
        className,
      )}
      {...props}
    />
  );
}

// Drawn with ui/radio-group's look instead of using its Radio: Radio only checks inside a
// RadioGroup, whose arrow keys select options and would trip the single-select auto-advance.
function OptionRadio({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex size-4.5 shrink-0 items-center justify-center rounded-full border border-foreground/55 bg-background not-dark:bg-clip-padding sm:size-4 dark:bg-input/32",
        checked ? "shadow-none" : "shadow-xs/5",
      )}
    >
      {checked ? (
        <span className="-inset-px absolute flex items-center justify-center rounded-full bg-primary before:size-2 before:rounded-full before:bg-primary-foreground sm:before:size-1.5" />
      ) : null}
    </span>
  );
}
