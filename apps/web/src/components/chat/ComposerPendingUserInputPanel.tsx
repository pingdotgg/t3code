import { type RuntimeRequestId, type ScopedThreadRef } from "@t3tools/contracts";
import { markdownProseDirection, textDirection } from "~/textDirection";
import { T, useGT } from "gt-react";
import { memo, use, useEffect, useEffectEvent, useRef, useState } from "react";
import { BackgroundThreadContext } from "./backgroundThread";
import { useStableCallback } from "~/hooks/useStableCallback";
import { type PendingUserInput } from "../../session-logic";
import type { PendingUserInputDraftAnswer } from "@t3tools/client-runtime/state/pending-user-input";
import { derivePendingUserInputProgress } from "../../pendingUserInput";
import { CheckboxMark } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Kbd } from "../ui/kbd";
import { cn } from "~/lib/utils";
import { isInSideChatPane } from "~/lib/sideChatPane";
import { ComposerBanner } from "./ComposerBanner";
import ChatMarkdown from "../ChatMarkdown";
import { Input } from "../ui/input";

interface PendingUserInputPanelProps {
  pendingUserInputs: PendingUserInput[];
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
  disabled?: boolean | undefined;
  respondingRequestIds: RuntimeRequestId[];
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionValue: string) => void;
  onSelectOther?: ((questionId: string) => void) | undefined;
  onChangeCustomAnswer?: ((questionId: string, value: string) => void) | undefined;
  onAdvance: () => void;
  onDismiss: (requestId: RuntimeRequestId) => void;
  onFocusComposer?: (() => void) | undefined;
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
  onSelectOther,
  onChangeCustomAnswer,
  onAdvance,
  onDismiss,
  onFocusComposer,
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
      onSelectOther={onSelectOther}
      onChangeCustomAnswer={onChangeCustomAnswer}
      onAdvance={onAdvance}
      onDismiss={onDismiss}
      onFocusComposer={onFocusComposer}
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
  onSelectOther,
  onChangeCustomAnswer,
  onAdvance,
  onDismiss,
  onFocusComposer: _onFocusComposer,
}: {
  prompt: PendingUserInput;
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
  disabled: boolean;
  isResponding: boolean;
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionValue: string) => void;
  onSelectOther?: ((questionId: string) => void) | undefined;
  onChangeCustomAnswer?: ((questionId: string, value: string) => void) | undefined;
  onAdvance: () => void;
  onDismiss: (requestId: RuntimeRequestId) => void;
  onFocusComposer?: (() => void) | undefined;
}) {
  const gt = useGT();
  // Message-mode requests remain answerable after their provider turn ends.
  const canRespond = prompt.responseCapability !== "not_resumable";
  const responseDisabled = disabled || isResponding || !canRespond;
  const autoAdvanceTimerRef = useRef<number | null>(null);
  const otherInputRef = useRef<HTMLInputElement>(null);
  const advance = useStableCallback(onAdvance);
  const [optimisticSingleSelect, setOptimisticSingleSelect] = useState<{
    questionId: string;
    optionValue: string;
  } | null>(null);
  const [collapsedQuestionId, setCollapsedQuestionId] = useState<string | null>(null);
  // Keep question identity stable for its shortcut listener.
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);
  const activeQuestion = progress.activeQuestion;
  const customAnswerActive =
    (progress.activeDraft?.otherSelected === true &&
      (progress.selectedOptionValues.length === 0 || activeQuestion?.multiSelect)) ||
    progress.customAnswer.trim().length > 0;
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

  const handleSelectOtherOption = () => {
    if (disabled || isResponding || !activeQuestion) return;
    if (autoAdvanceTimerRef.current !== null) {
      window.clearTimeout(autoAdvanceTimerRef.current);
      autoAdvanceTimerRef.current = null;
    }
    setOptimisticSingleSelect(null);
    if (onSelectOther) {
      onSelectOther(activeQuestion.id);
    } else {
      for (const val of progress.selectedOptionValues) {
        onToggleOption(activeQuestion.id, val);
      }
    }
    window.requestAnimationFrame(() => {
      otherInputRef.current?.focus();
    });
  };

  const selectOptionFromShortcut = useEffectEvent(handleOptionSelection);
  const selectOtherFromShortcut = useEffectEvent(handleSelectOtherOption);
  const backgroundThread = use(BackgroundThreadContext);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes a document keydown listener for digit shortcuts while a question is answerable
  useEffect(() => {
    if (!activeQuestion || responseDisabled || isCollapsed || backgroundThread) return;
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
      if (optionIndex < activeQuestion.options.length) {
        const option = activeQuestion.options[optionIndex];
        if (!option) return;
        event.preventDefault();
        selectOptionFromShortcut(activeQuestion.id, option.value ?? option.label);
      } else if (
        optionIndex === activeQuestion.options.length &&
        activeQuestion.options.length > 0
      ) {
        event.preventDefault();
        selectOtherFromShortcut();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeQuestion, backgroundThread, isCollapsed, responseDisabled]);

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
          isCollapsed
            ? gt("Show the question and its options")
            : gt("Hide the question and its options")
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
              aria-label={gt("Dismiss question without answering")}
              title={gt("Dismiss question without answering")}
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
                      disabled={disabled || isResponding}
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
              {activeQuestion.options.length > 0 && (
                <div>
                  <button
                    type="button"
                    aria-pressed={customAnswerActive}
                    disabled={disabled || isResponding}
                    onClick={handleSelectOtherOption}
                    className={cn(
                      questionTextAlign,
                      "group flex w-full items-start gap-2.5 rounded-md bg-transparent py-1.5 ps-2 sm:ps-1.5 outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/25",
                      customAnswerActive
                        ? "text-foreground"
                        : "text-foreground/70 hover:bg-muted/30",
                      (disabled || isResponding) && "opacity-50 cursor-not-allowed",
                      !disabled && !isResponding && "cursor-pointer",
                    )}
                  >
                    <span className="pointer-events-none flex h-5 shrink-0 items-center">
                      {activeQuestion.multiSelect ? (
                        <CheckboxMark checked={customAnswerActive} variant="contrast" />
                      ) : (
                        <OptionRadio checked={customAnswerActive} />
                      )}
                    </span>
                    <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                      <span className="text-sm font-medium">
                        <T>Other</T>
                      </span>
                      <span className="text-secondary-label text-2xs">
                        {customAnswerActive ? (
                          <T>Type your custom answer below</T>
                        ) : (
                          <T>Type a custom response or suggestion</T>
                        )}
                      </span>
                    </div>
                    {activeQuestion.options.length < 9 ? (
                      <span className="flex h-5 w-7 shrink-0 items-center justify-center sm:w-6">
                        <Kbd>{activeQuestion.options.length + 1}</Kbd>
                      </span>
                    ) : null}
                  </button>
                  {customAnswerActive && (
                    <div
                      className="ps-9 pe-2 pb-1.5 sm:ps-8"
                      onClick={(e) => {
                        e.stopPropagation();
                      }}
                    >
                      <Input
                        ref={otherInputRef}
                        size="compact"
                        value={progress.customAnswer}
                        placeholder={gt("Type your custom answer...")}
                        disabled={disabled || isResponding}
                        onChange={(e) => {
                          onChangeCustomAnswer?.(activeQuestion.id, e.target.value);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            if (
                              e.nativeEvent.isComposing ||
                              e.nativeEvent.keyCode === 229 ||
                              e.keyCode === 229
                            ) {
                              return;
                            }
                            e.preventDefault();
                            if (progress.canAdvance) {
                              advance();
                            }
                          }
                        }}
                      />
                    </div>
                  )}
                </div>
              )}
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
