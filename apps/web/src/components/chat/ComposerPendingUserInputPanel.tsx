import { type RuntimeRequestId, type ScopedThreadRef } from "@t3tools/contracts";
import { markdownProseDirection, textDirection } from "~/textDirection";
import { memo, use, useEffect, useImperativeHandle, useRef, useState, type RefObject } from "react";
import { BackgroundThreadContext } from "./backgroundThread";
import { useStableCallback } from "~/hooks/useStableCallback";
import { type PendingUserInput } from "../../session-logic";
import type { PendingUserInputDraftAnswer } from "@t3tools/client-runtime/state/pending-user-input";
import { derivePendingUserInputProgress } from "../../pendingUserInput";
import { CheckboxMark } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Kbd } from "../ui/kbd";
import { cn } from "~/lib/utils";
import { ComposerBanner } from "./ComposerBanner";
import type { PendingQuestionKeyTarget } from "./composerFocusRedirect";
import ChatMarkdown from "../ChatMarkdown";

/** Returns true when the open question claimed the key. */
export type PendingQuestionKeyHandler = (
  event: Pick<KeyboardEvent, "key" | "repeat">,
  target: PendingQuestionKeyTarget,
) => boolean;

interface PendingUserInputPanelProps {
  pendingUserInputs: PendingUserInput[];
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
  disabled?: boolean;
  respondingRequestIds: RuntimeRequestId[];
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  /** Holds this panel's keyboard handler while a question is shown. */
  keyHandlerRef: RefObject<PendingQuestionKeyHandler | null>;
  onToggleOption: (questionId: string, optionValue: string) => void;
  /** Types an option number into the answer, where it picks the option. */
  onOptionKey: (questionId: string, key: string) => void;
  /** Takes back the last option number; false when there is none. */
  onRemoveOptionKey: (questionId: string) => boolean;
  onAdvance: () => void;
  /** Confirms the active question, as the composer's Next button does. */
  onConfirm: () => void;
  onDismiss: (requestId: RuntimeRequestId) => void;
}

export const ComposerPendingUserInputPanel = memo(function ComposerPendingUserInputPanel({
  pendingUserInputs,
  cwd,
  threadRef,
  disabled = false,
  respondingRequestIds,
  answers,
  questionIndex,
  keyHandlerRef,
  onToggleOption,
  onOptionKey,
  onRemoveOptionKey,
  onAdvance,
  onConfirm,
  onDismiss,
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
      keyHandlerRef={keyHandlerRef}
      onToggleOption={onToggleOption}
      onOptionKey={onOptionKey}
      onRemoveOptionKey={onRemoveOptionKey}
      onAdvance={onAdvance}
      onConfirm={onConfirm}
      onDismiss={onDismiss}
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
  keyHandlerRef,
  onToggleOption,
  onOptionKey,
  onRemoveOptionKey,
  onAdvance,
  onConfirm,
  onDismiss,
}: {
  prompt: PendingUserInput;
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
  disabled: boolean;
  isResponding: boolean;
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  keyHandlerRef: RefObject<PendingQuestionKeyHandler | null>;
  onToggleOption: (questionId: string, optionValue: string) => void;
  onOptionKey: (questionId: string, key: string) => void;
  onRemoveOptionKey: (questionId: string) => boolean;
  onAdvance: () => void;
  onConfirm: () => void;
  onDismiss: (requestId: RuntimeRequestId) => void;
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

  const backgroundThread = use(BackgroundThreadContext);

  // The chat's shortcuts offer keys here before type-to-focus. While the answer field
  // shows no text, 1-9 go into it as option keys that pick options and Backspace takes
  // the last one back. Keyboard picks wait for Enter, which confirms like Next; only a
  // click on a single-choice option advances by itself.
  useImperativeHandle(keyHandlerRef, () => (event, target) => {
    if (!activeQuestion || responseDisabled || backgroundThread) return false;
    if (event.key === "Enter") {
      // The answer field and other controls keep their own Enter. A focused
      // single-select option keeps its click, which picks and advances.
      if (
        isCollapsed ||
        (target !== "page" && !(target === "option" && activeQuestion.multiSelect))
      ) {
        return false;
      }
      if (!event.repeat) onConfirm();
      return true;
    }
    if (event.key === "Backspace") {
      return target !== "control" && onRemoveOptionKey(activeQuestion.id);
    }
    if (
      progress.customAnswer.length > 0 ||
      activeQuestion.initialAnswer !== undefined ||
      !/^[1-9]$/.test(event.key) ||
      !activeQuestion.options[Number(event.key) - 1]
    ) {
      return false;
    }
    if (!event.repeat) {
      setCollapsedQuestionId(null);
      onOptionKey(activeQuestion.id, event.key);
    }
    return true;
  });

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

  return (
    <Collapsible
      dir={promptDirection}
      open={!isCollapsed}
      onOpenChange={(open) => {
        setCollapsedQuestionId(open ? null : activeQuestion.id);
      }}
    >
      <CollapsibleTrigger
        render={<ComposerBanner.Row render={<button type="button" />} />}
        title={
          isCollapsed ? "Show the question and its options" : "Hide the question and its options"
        }
        data-pending-user-input-toggle={isCollapsed ? "collapsed" : "expanded"}
        className="px-4 py-1.5"
      >
        <ComposerBanner.Content>
          <span
            className={cn("min-w-0 truncate text-muted-foreground", isCollapsed && "max-w-1/2")}
            dir={textDirection(activeQuestion.header)}
          >
            {activeQuestion.header}
          </span>
          {isCollapsed ? (
            <>
              <ComposerBanner.Separator />
              <span
                className={cn("min-w-0 flex-1 truncate text-secondary-label", questionTextAlign)}
                dir={markdownProseDirection(activeQuestion.question)}
              >
                {activeQuestion.question}
              </span>
            </>
          ) : null}
        </ComposerBanner.Content>
        <ComposerBanner.Actions className="gap-0">
          {prompt.questions.length > 1 ? (
            <ComposerBanner.Count>
              {questionIndex + 1}/{prompt.questions.length}
            </ComposerBanner.Count>
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
        </ComposerBanner.Actions>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <ComposerBanner.Scroll>
          <ComposerBanner.Body className="ps-6 pe-4 pb-1 wrap-anywhere sm:ps-5.5">
            <ChatMarkdown
              text={activeQuestion.question}
              cwd={cwd}
              threadRef={threadRef}
              lineBreaks
              className={cn("pt-0.5 text-foreground/85", questionTextAlign)}
            />
            {/* Rows span the header row's width so the radios align with the question text and the shortcut column sits under the dismiss button. */}
            <div className="-ms-2 mt-1.5 sm:-ms-1.5">
              {activeQuestion.options.map((option, index) => {
                const optionValue = option.value ?? option.label;
                const isOptimisticallySelected =
                  optimisticSingleSelect?.questionId === activeQuestion.id &&
                  optimisticSingleSelect.optionValue === optionValue;
                const isSelected =
                  isOptimisticallySelected || draftSelectedOptions?.[index] === true;
                const className = cn(
                  questionTextAlign,
                  "group flex w-full items-start gap-2.5 rounded-md bg-transparent py-1.5 ps-2 sm:ps-1.5 outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/25",
                  isSelected ? "text-foreground" : "text-foreground/70 hover:bg-muted/30",
                  (disabled || isResponding) && "opacity-50 cursor-not-allowed",
                  !disabled && !isResponding && "cursor-pointer",
                );
                // The h-5 slots match the label's line box, so the indicator and shortcut stay on its first line.
                const content = (
                  <>
                    <span className="pointer-events-none flex h-5 shrink-0 items-center">
                      {activeQuestion.multiSelect ? (
                        <CheckboxMark checked={isSelected} variant="contrast" />
                      ) : (
                        <OptionRadio checked={isSelected} />
                      )}
                    </span>
                    <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                      <span className="text-sm font-medium" dir={textDirection(option.label)}>
                        {option.label}
                      </span>
                      {option.description && option.description !== option.label ? (
                        <span
                          className="text-secondary-label text-2xs"
                          dir={textDirection(option.description)}
                        >
                          {option.description}
                        </span>
                      ) : null}
                    </div>
                    {index < 9 ? (
                      <span className="flex h-5 w-7 shrink-0 items-center justify-center sm:w-6">
                        <Kbd>{index + 1}</Kbd>
                      </span>
                    ) : null}
                  </>
                );
                // The preview sits outside the button: it can hold links, and a click on a single-select option advances.
                return (
                  <div key={`${activeQuestion.id}:${optionValue}`}>
                    <button
                      type="button"
                      aria-pressed={isSelected}
                      data-pending-user-input-option
                      disabled={disabled || isResponding}
                      // A click leaves focus where it was, so Enter confirms the
                      // question instead of pressing the option just clicked again.
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => {
                        handleOptionSelection(activeQuestion.id, optionValue);
                      }}
                      className={className}
                    >
                      {content}
                    </button>
                    {option.preview ? (
                      <ChatMarkdown
                        text={option.preview}
                        cwd={cwd}
                        threadRef={threadRef}
                        lineBreaks
                        className="ps-9 pe-2 pb-1.5 text-xs text-foreground/70 sm:ps-8"
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          </ComposerBanner.Body>
        </ComposerBanner.Scroll>
      </CollapsiblePanel>
    </Collapsible>
  );
});

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
