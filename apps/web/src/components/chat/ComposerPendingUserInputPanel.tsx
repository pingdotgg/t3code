import { type RuntimeRequestId, type ScopedThreadRef } from "@t3tools/contracts";
import { memo, useCallback, useEffect, useId, useRef, useState } from "react";
import ChatMarkdown from "../ChatMarkdown";
import { type PendingUserInput } from "../../session-logic";
import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { CheckIcon } from "lucide-react";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { cn } from "~/lib/utils";
import { ComposerBanner } from "./ComposerBanner";

interface PendingUserInputPanelProps {
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
  pendingUserInputs: PendingUserInput[];
  disabled?: boolean;
  respondingRequestIds: RuntimeRequestId[];
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionValue: string) => void;
  onAdvance: () => void;
  onDismiss: (requestId: RuntimeRequestId) => void;
}

export const ComposerPendingUserInputPanel = memo(function ComposerPendingUserInputPanel({
  cwd,
  threadRef,
  pendingUserInputs,
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
      cwd={cwd}
      threadRef={threadRef}
      key={activePrompt.requestId}
      prompt={activePrompt}
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
  cwd,
  threadRef,
  prompt,
  disabled,
  isResponding,
  answers,
  questionIndex,
  onToggleOption,
  onAdvance,
  onDismiss,
}: {
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
  prompt: PendingUserInput;
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
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);
  const optionIdPrefix = useId();
  const headerId = `${optionIdPrefix}-header`;
  const previewId = `${optionIdPrefix}-preview`;
  const activeQuestion = progress.activeQuestion;
  const autoAdvanceTimerRef = useRef<number | null>(null);
  const onAdvanceRef = useRef(onAdvance);
  const [optimisticSingleSelect, setOptimisticSingleSelect] = useState<{
    questionId: string;
    optionValue: string;
  } | null>(null);
  // Collapsing hides everything but the header so a tall prompt stops covering
  // the thread the user is trying to read. Scoped to a single question: the card
  // is keyed by request id so the next prompt starts expanded, and storing the
  // collapsed question's id (rather than a bare flag) reopens the card when the
  // prompt advances to its next question, which can happen without a click —
  // sending from the composer advances the active question.
  const [collapsedQuestionId, setCollapsedQuestionId] = useState<string | null>(null);
  const isCollapsed = collapsedQuestionId !== null && collapsedQuestionId === activeQuestion?.id;

  useEffect(() => {
    onAdvanceRef.current = onAdvance;
  }, [onAdvance]);

  useEffect(() => {
    if (!activeQuestion || activeQuestion.multiSelect || !optimisticSingleSelect) {
      return;
    }
    if (optimisticSingleSelect.questionId !== activeQuestion.id) {
      setOptimisticSingleSelect(null);
      return;
    }
    if (
      progress.customAnswer.trim().length === 0 &&
      progress.selectedOptionValues.includes(optimisticSingleSelect.optionValue)
    ) {
      setOptimisticSingleSelect(null);
    }
  }, [
    activeQuestion,
    optimisticSingleSelect,
    progress.customAnswer,
    progress.selectedOptionValues,
  ]);

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

  const handleOptionSelection = useCallback(
    (questionId: string, optionValue: string) => {
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
        onAdvanceRef.current();
      }, 200);
    },
    [activeQuestion, disabled, isResponding, onToggleOption],
  );

  // Keyboard shortcut: number keys 1-9 select corresponding options when focus is
  // outside editable fields. Multi-select prompts toggle options in place; single-
  // select prompts keep the existing auto-advance behavior. Collapsed prompts opt
  // out, since the numbers they refer to are not on screen.
  useEffect(() => {
    if (!activeQuestion || responseDisabled || isCollapsed) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
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
      if (optionIndex >= activeQuestion.options.length) return;
      const option = activeQuestion.options[optionIndex];
      if (!option) return;
      event.preventDefault();
      handleOptionSelection(activeQuestion.id, option.value ?? option.label);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeQuestion, handleOptionSelection, isCollapsed, responseDisabled]);

  if (!activeQuestion) {
    return null;
  }

  const customAnswerActive = progress.customAnswer.trim().length > 0;

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
            <span
              id={previewId}
              inert
              className="min-w-0 flex-1 text-secondary-label"
              data-pending-user-input-preview
            >
              <ChatMarkdown
                text={activeQuestion.question}
                cwd={cwd}
                threadRef={threadRef}
                className="line-clamp-1 max-h-lh"
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
            <ChatMarkdown text={activeQuestion.question} cwd={cwd} threadRef={threadRef} />
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
                  isOptimisticallySelected ||
                  (!customAnswerActive && progress.selectedOptionValues.includes(optionValue));
                const shortcutKey = index < 9 ? index + 1 : null;
                const labelId = `${optionIdPrefix}-${index}-label`;
                const descriptionId = `${optionIdPrefix}-${index}-description`;
                const hasDescription = option.description && option.description !== option.label;
                const className = cn(
                  "group relative flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors duration-150",
                  isSelected
                    ? "bg-muted/55 text-foreground"
                    : "bg-transparent text-foreground/85 hover:bg-muted/30",
                  (disabled || isResponding) && "opacity-50 cursor-not-allowed",
                  !disabled && !isResponding && "cursor-pointer",
                );
                const content = (
                  <>
                    <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                      <div id={labelId}>
                        <ChatMarkdown
                          text={option.label}
                          cwd={cwd}
                          threadRef={threadRef}
                          className="text-sm font-medium [&_a]:pointer-events-auto [&_button]:pointer-events-auto [&_[role=button]]:pointer-events-auto [&_video[controls]]:pointer-events-auto"
                        />
                      </div>
                      {hasDescription ? (
                        <div id={descriptionId}>
                          <ChatMarkdown
                            text={option.description}
                            cwd={cwd}
                            threadRef={threadRef}
                            className="text-secondary-label text-2xs [&_a]:pointer-events-auto [&_button]:pointer-events-auto [&_[role=button]]:pointer-events-auto [&_video[controls]]:pointer-events-auto"
                          />
                        </div>
                      ) : null}
                    </div>
                    {isSelected ? (
                      <CheckIcon className="size-3.5 shrink-0 text-primary" />
                    ) : shortcutKey !== null ? (
                      <kbd
                        className={cn(
                          "flex size-5 shrink-0 items-center justify-center text-3xs font-medium text-muted-foreground tabular-nums",
                        )}
                      >
                        {shortcutKey}
                      </kbd>
                    ) : null}
                  </>
                );
                return (
                  <div key={`${activeQuestion.id}:${optionValue}`} className={className}>
                    <button
                      type="button"
                      disabled={disabled || isResponding}
                      aria-labelledby={labelId}
                      aria-describedby={hasDescription ? descriptionId : undefined}
                      aria-pressed={isSelected}
                      onClick={() => handleOptionSelection(activeQuestion.id, optionValue)}
                      className="absolute inset-0 rounded-md outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/25"
                    />
                    <div className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-2 [&_[data-slot^=scroll-area-]]:pointer-events-auto [&_pre]:pointer-events-auto [&_.overflow-x-auto]:pointer-events-auto">
                      {content}
                    </div>
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
