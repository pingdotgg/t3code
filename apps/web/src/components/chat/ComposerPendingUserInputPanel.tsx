import { type RuntimeRequestId, type ScopedThreadRef } from "@t3tools/contracts";
import { memo, useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { useStableCallback } from "~/hooks/useStableCallback";
import { type PendingUserInput } from "../../session-logic";
import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { CheckIcon } from "lucide-react";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { cn } from "~/lib/utils";
import { ComposerBanner } from "./ComposerBanner";
import ChatMarkdown from "../ChatMarkdown";

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
}) {
  // Message-mode requests remain answerable after their provider turn ends.
  const canRespond = prompt.responseCapability !== "not_resumable";
  const responseDisabled = disabled || isResponding || !canRespond;
  const autoAdvanceTimerRef = useRef<number | null>(null);
  // The auto-advance timer fires after the render that armed it.
  const advance = useStableCallback(onAdvance);
  const [optimisticSingleSelect, setOptimisticSingleSelect] = useState<{
    questionId: string;
    optionValue: string;
  } | null>(null);
  const [focusedOption, setFocusedOption] = useState<{
    questionId: string;
    optionIndex: number;
  } | null>(null);
  const [collapsedQuestionId, setCollapsedQuestionId] = useState<string | null>(null);
  // The active question keys the shortcut listener, so it must keep its identity across renders.
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);
  const optionIdPrefix = useId();
  const headerId = `${optionIdPrefix}-header`;
  const previewId = `${optionIdPrefix}-preview`;
  const activeQuestion = progress.activeQuestion;
  const customAnswerActive = progress.customAnswer.trim().length > 0;
  // Read here, before the hooks below, so the compiler can keep `activeQuestion` cached.
  const draftSelectedOptions = activeQuestion?.options.map(
    (option) =>
      !customAnswerActive && progress.selectedOptionValues.includes(option.value ?? option.label),
  );
  const isCollapsed = collapsedQuestionId !== null && collapsedQuestionId === activeQuestion?.id;
  const selectedOptionValue = progress.selectedOptionValues.at(-1);
  const savedOptionMatches = activeQuestion?.options.filter(
    (option) => (option.value ?? option.label) === selectedOptionValue,
  );
  const previewOption = customAnswerActive
    ? undefined
    : focusedOption && focusedOption.questionId === activeQuestion?.id
      ? activeQuestion?.options[focusedOption.optionIndex]
      : selectedOptionValue === undefined
        ? activeQuestion?.options[0]
        : savedOptionMatches?.length === 1
          ? savedOptionMatches[0]
          : undefined;

  if (focusedOption && (focusedOption.questionId !== activeQuestion?.id || customAnswerActive)) {
    setFocusedOption(null);
  }

  // The optimistic pick is dropped once the draft confirms it or the question moves on.
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

  // A delayed answer only advances its own question, while permission remains granted.
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

  const handleOptionSelection = (questionId: string, optionValue: string, optionIndex: number) => {
    if (disabled || isResponding) return;
    setFocusedOption({ questionId, optionIndex });
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

  useEffect(() => {
    if (!activeQuestion || responseDisabled || isCollapsed) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLMediaElement
      ) {
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
      if (optionIndex >= activeQuestion.options.length) return;
      const option = activeQuestion.options[optionIndex];
      if (!option) return;
      event.preventDefault();
      selectOptionFromShortcut(activeQuestion.id, option.value ?? option.label, optionIndex);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeQuestion, isCollapsed, responseDisabled]);

  if (!activeQuestion) {
    return null;
  }

  return (
    <Collapsible
      open={!isCollapsed}
      onOpenChange={(open) => {
        setCollapsedQuestionId(open ? null : activeQuestion.id);
      }}
    >
      <ComposerBanner.Row className="relative">
        <CollapsibleTrigger
          render={<button type="button" />}
          className="absolute inset-0 cursor-pointer rounded-md focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          aria-labelledby={headerId}
          aria-describedby={isCollapsed ? previewId : undefined}
          title={
            isCollapsed ? "Show the question and its options" : "Hide the question and its options"
          }
          data-pending-user-input-toggle={isCollapsed ? "collapsed" : "expanded"}
        />
        <ComposerBanner.Icon className="pointer-events-none relative" />
        <ComposerBanner.Content className="pointer-events-none relative">
          <span id={headerId} className="shrink-0 font-medium text-muted-foreground">
            {activeQuestion.header}
          </span>
          {isCollapsed ? (
            <span id={previewId} inert className="min-w-0 flex-1" data-pending-user-input-preview>
              <ChatMarkdown
                text={activeQuestion.question}
                parseRawHtml={false}
                cwd={cwd}
                threadRef={threadRef}
                className="line-clamp-1 max-h-lh text-xs/4 text-secondary-label"
              />
            </span>
          ) : null}
        </ComposerBanner.Content>
        <ComposerBanner.Actions className="pointer-events-none relative">
          {prompt.questions.length > 1 ? (
            <span className="text-3xs font-medium text-muted-foreground tabular-nums">
              {questionIndex + 1}/{prompt.questions.length}
            </span>
          ) : null}
          <ComposerBanner.ToggleIcon expanded={!isCollapsed} />
          {prompt.dismissible ? (
            <span className="pointer-events-auto inline-flex">
              <ComposerBanner.Dismiss
                aria-label="Dismiss question without answering"
                title="Dismiss question without answering"
                disabled={isResponding}
                data-pending-user-input-dismiss
                onClick={() => onDismiss(prompt.requestId)}
              />
            </span>
          ) : null}
        </ComposerBanner.Actions>
      </ComposerBanner.Row>
      <CollapsiblePanel>
        <ComposerBanner.Scroll>
          <ComposerBanner.Body className="pe-1 pb-1 wrap-anywhere">
            <ChatMarkdown
              text={activeQuestion.question}
              cwd={cwd}
              threadRef={threadRef}
              className="text-foreground/85"
            />
            {activeQuestion.multiSelect ? (
              <p className="mt-1 text-secondary-label text-xs">Select one or more options.</p>
            ) : null}
            <div className="mt-2 space-y-0.5">
              {activeQuestion.options.map((option, index) => {
                const optionValue = option.value ?? option.label;
                const isOptimisticallySelected =
                  optimisticSingleSelect?.questionId === activeQuestion.id &&
                  optimisticSingleSelect.optionValue === optionValue;
                const isSelected =
                  isOptimisticallySelected || draftSelectedOptions?.[index] === true;
                const shortcutKey = index < 9 ? index + 1 : null;
                const labelId = `${optionIdPrefix}-${index}-label`;
                const descriptionId = `${optionIdPrefix}-${index}-description`;
                const hasDescription = option.description && option.description !== option.label;
                return (
                  <div
                    // Options keep their positions within a question and may share answer values.
                    // oxlint-disable-next-line react/no-array-index-key
                    key={`${activeQuestion.id}:${index}`}
                    className={cn(
                      "group flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors duration-150 has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-primary/25",
                      isSelected
                        ? "bg-muted/55 text-foreground"
                        : "bg-transparent text-foreground/85 hover:bg-muted/30",
                      (disabled || isResponding) && "opacity-50 cursor-not-allowed",
                      !disabled && !isResponding && "cursor-pointer",
                    )}
                    onMouseEnter={() =>
                      setFocusedOption({ questionId: activeQuestion.id, optionIndex: index })
                    }
                    onClick={(event) => {
                      const target = event.target;
                      if (
                        event.defaultPrevented ||
                        !(target instanceof Element) ||
                        !event.currentTarget.contains(target)
                      )
                        return;
                      // Markdown controls and scroll surfaces keep their own click behavior.
                      const control = target.closest(
                        'a, button, input, select, textarea, summary, video, audio, [role="button"], [role="link"], [contenteditable], [data-slot^="scroll-area-"], pre, .overflow-x-auto',
                      );
                      if (control && event.currentTarget.contains(control)) return;
                      handleOptionSelection(activeQuestion.id, optionValue, index);
                    }}
                  >
                    <button
                      type="button"
                      disabled={disabled || isResponding}
                      aria-labelledby={labelId}
                      aria-describedby={hasDescription ? descriptionId : undefined}
                      aria-pressed={isSelected}
                      onFocus={() =>
                        setFocusedOption({ questionId: activeQuestion.id, optionIndex: index })
                      }
                      onClick={() => handleOptionSelection(activeQuestion.id, optionValue, index)}
                      className="order-last flex w-5 shrink-0 self-stretch items-center justify-center rounded-sm outline-none disabled:cursor-not-allowed"
                    >
                      {isSelected ? (
                        <CheckIcon aria-hidden className="size-3.5 text-primary" />
                      ) : shortcutKey !== null ? (
                        <kbd
                          aria-hidden
                          className="text-3xs font-medium text-muted-foreground tabular-nums"
                        >
                          {shortcutKey}
                        </kbd>
                      ) : null}
                    </button>
                    <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                      <div id={labelId}>
                        <ChatMarkdown
                          text={option.label}
                          cwd={cwd}
                          threadRef={threadRef}
                          parseRawHtml={false}
                          className="text-sm font-medium text-current"
                        />
                      </div>
                      {hasDescription ? (
                        <div id={descriptionId}>
                          <ChatMarkdown
                            text={option.description}
                            cwd={cwd}
                            threadRef={threadRef}
                            parseRawHtml={false}
                            className="text-secondary-label text-2xs"
                          />
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
            {previewOption?.preview?.trim() ? (
              <section
                aria-label={`Preview: ${previewOption.label}`}
                className="mt-2 min-w-0 rounded-md border border-border/60 bg-muted/25 p-2.5"
              >
                <p className="mb-1.5 text-3xs font-medium text-muted-foreground">
                  Preview · {previewOption.label}
                </p>
                <ChatMarkdown
                  key={`${activeQuestion.id}:${activeQuestion.options.indexOf(previewOption)}`}
                  text={previewOption.preview}
                  cwd={cwd}
                  threadRef={threadRef}
                  parseRawHtml={false}
                />
              </section>
            ) : null}
          </ComposerBanner.Body>
        </ComposerBanner.Scroll>
      </CollapsiblePanel>
    </Collapsible>
  );
});
