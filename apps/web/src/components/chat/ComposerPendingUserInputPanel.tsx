import { memo, useEffect, useEffectEvent, useState } from "react";
import { type PendingUserInput } from "../../session-logic";
import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { CheckIcon } from "lucide-react";
import { cn } from "~/lib/utils";

interface PendingUserInputPanelProps {
  pendingUserInputs: PendingUserInput[];
  isResponding: boolean;
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onSelectOption: (
    questionId: string,
    optionLabel: string,
    options?: {
      advanceToNextQuestion?: boolean;
      submitIfComplete?: boolean;
    },
  ) => void;
}

export const ComposerPendingUserInputPanel = memo(function ComposerPendingUserInputPanel({
  pendingUserInputs,
  isResponding,
  answers,
  questionIndex,
  onSelectOption,
}: PendingUserInputPanelProps) {
  if (pendingUserInputs.length === 0) return null;
  const activePrompt = pendingUserInputs[0];
  if (!activePrompt) return null;

  return (
    <ComposerPendingUserInputCard
      key={activePrompt.requestId}
      prompt={activePrompt}
      isResponding={isResponding}
      answers={answers}
      questionIndex={questionIndex}
      onSelectOption={onSelectOption}
    />
  );
});

const ComposerPendingUserInputCard = memo(function ComposerPendingUserInputCard({
  prompt,
  isResponding,
  answers,
  questionIndex,
  onSelectOption,
}: {
  prompt: PendingUserInput;
  isResponding: boolean;
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onSelectOption: (
    questionId: string,
    optionLabel: string,
    options?: {
      advanceToNextQuestion?: boolean;
      submitIfComplete?: boolean;
    },
  ) => void;
}) {
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);
  const activeQuestion = progress.activeQuestion;
  const [optimisticSingleSelect, setOptimisticSingleSelect] = useState<{
    questionId: string;
    optionLabel: string;
  } | null>(null);

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
      progress.selectedOptionLabels.includes(optimisticSingleSelect.optionLabel)
    ) {
      setOptimisticSingleSelect(null);
    }
  }, [
    activeQuestion,
    optimisticSingleSelect,
    progress.customAnswer,
    progress.selectedOptionLabels,
  ]);

  // ponytail: deterministic auto-advance/submit replaces the prior timeout race.
  // Selecting a preset immediately advances (or submits on the last question)
  // instead of waiting on a timer that could fire after stale custom edits.
  const handleOptionSelection = useEffectEvent((questionId: string, optionLabel: string) => {
    if (activeQuestion?.multiSelect) {
      onSelectOption(questionId, optionLabel);
      return;
    }
    setOptimisticSingleSelect({ questionId, optionLabel });
    onSelectOption(
      questionId,
      optionLabel,
      progress.isLastQuestion ? { submitIfComplete: true } : { advanceToNextQuestion: true },
    );
  });

  // Keyboard shortcut: number keys 1-9 select corresponding options when focus is
  // outside editable fields. Multi-select prompts toggle options in place; single-
  // select prompts keep the existing auto-advance behavior.
  useEffect(() => {
    if (!activeQuestion || isResponding) return;
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
      handleOptionSelection(activeQuestion.id, option.label);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeQuestion, isResponding]);

  if (!activeQuestion) {
    return null;
  }

  const customAnswerActive = progress.customAnswer.trim().length > 0;

  return (
    <div className="px-4 py-3 sm:px-5">
      <div className="mb-2 flex items-center gap-3">
        <span className="text-[11px] font-semibold tracking-widest text-muted-foreground/55 uppercase">
          {activeQuestion.header}
        </span>
        {prompt.questions.length > 1 ? (
          <span className="flex h-5 items-center rounded-md bg-muted/60 px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground/60">
            {questionIndex + 1}/{prompt.questions.length}
          </span>
        ) : null}
      </div>
      <p className="text-sm text-foreground/90">{activeQuestion.question}</p>
      {activeQuestion.multiSelect ? (
        <p className="mt-1 text-xs text-muted-foreground/65">Select one or more options.</p>
      ) : null}
      <div className="mt-3 space-y-1.5">
        {activeQuestion.options.map((option, index) => {
          const isOptimisticallySelected =
            optimisticSingleSelect?.questionId === activeQuestion.id &&
            optimisticSingleSelect.optionLabel === option.label;
          const isSelected =
            isOptimisticallySelected ||
            (!customAnswerActive && progress.selectedOptionLabels.includes(option.label));
          const shortcutKey = index < 9 ? index + 1 : null;
          const className = cn(
            "group flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left outline-none transition-all duration-150 focus-visible:border-primary/40 focus-visible:ring-1 focus-visible:ring-primary/25",
            isSelected
              ? "border-primary/30 bg-primary/8 text-foreground"
              : "border-transparent bg-muted/22 text-foreground/85 hover:border-border/45 hover:bg-muted/34",
            isResponding && "opacity-50 cursor-not-allowed",
            !isResponding && "cursor-pointer",
          );
          const content = (
            <>
              <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                <span className="text-sm font-medium">{option.label}</span>
                {option.description && option.description !== option.label ? (
                  <span className="text-xs text-muted-foreground/50">{option.description}</span>
                ) : null}
              </div>
              {isSelected ? (
                <CheckIcon className="size-3.5 shrink-0 text-primary" />
              ) : shortcutKey !== null ? (
                <kbd
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded border border-border/50 text-[11px] font-medium tabular-nums transition-colors duration-150",
                    "bg-background/35 text-muted-foreground/70 group-hover:border-border/70 group-hover:text-muted-foreground",
                  )}
                >
                  {shortcutKey}
                </kbd>
              ) : null}
            </>
          );
          return (
            <button
              key={`${activeQuestion.id}:${option.label}`}
              type="button"
              disabled={isResponding}
              onClick={() => {
                handleOptionSelection(activeQuestion.id, option.label);
              }}
              className={className}
            >
              {content}
            </button>
          );
        })}
      </div>
    </div>
  );
});
