import { isGenericUserInputQuestionHeader } from "@t3tools/client-runtime/state/thread-requests";
import { type RuntimeRequestId, type ScopedThreadRef } from "@t3tools/contracts";
import { memo, useEffect, useEffectEvent, useRef, useState } from "react";
import { useStableCallback } from "~/hooks/useStableCallback";
import { type PendingUserInput } from "../../session-logic";
import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { ArrowDownIcon, CheckIcon } from "lucide-react";
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
  const [collapsedQuestionId, setCollapsedQuestionId] = useState<string | null>(null);
  // The active question keys the shortcut listener, so it must keep its identity across renders.
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);
  const activeQuestion = progress.activeQuestion;
  const customAnswerActive = progress.customAnswer.trim().length > 0;
  // Read here, before the hooks below, so the compiler can keep `activeQuestion` cached.
  const draftSelectedOptions = activeQuestion?.options.map(
    (option) =>
      !customAnswerActive && progress.selectedOptionValues.includes(option.value ?? option.label),
  );
  const isCollapsed = collapsedQuestionId !== null && collapsedQuestionId === activeQuestion?.id;

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

  const handleOptionSelection = (questionId: string, optionValue: string) => {
    if (disabled || isResponding) return;
    if (
      activeQuestion?.options.some(
        (option) => option.customAnswer === true && (option.value ?? option.label) === optionValue,
      )
    ) {
      return;
    }
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
      const selectableOptions = activeQuestion.options.filter(
        (option) => option.customAnswer !== true,
      );
      const optionIndex = digit - 1;
      if (optionIndex >= selectableOptions.length) return;
      const option = selectableOptions[optionIndex];
      if (!option) return;
      event.preventDefault();
      selectOptionFromShortcut(activeQuestion.id, option.value ?? option.label);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeQuestion, isCollapsed, responseDisabled]);

  if (!activeQuestion) {
    return null;
  }
  const selectableOptionEntries = activeQuestion.options.flatMap((option, index) =>
    option.customAnswer === true ? [] : [{ option, index }],
  );
  const customAnswerOptions = activeQuestion.options.filter(
    (option) => option.customAnswer === true,
  );
  const showHeader = !isGenericUserInputQuestionHeader(activeQuestion.header);
  const toggleLabel = isCollapsed
    ? "Show the question and its options"
    : "Hide the question and its options";
  const queueTotal = prompt.queueQuestionTotal ?? prompt.questions.length;
  const questionCount =
    queueTotal > 1 ? `${(prompt.queueQuestionIndex ?? 0) + questionIndex + 1}/${queueTotal}` : null;
  // Pulls the caret's icon-box padding in so the count and caret read as one cluster.
  const questionCountClassName =
    "-me-2 text-xs/4 font-medium text-muted-foreground tabular-nums sm:-me-1.5";
  // Without an eyebrow to carry it, the multi-select hint rides in the actions row.
  const actionsHint =
    !isCollapsed && !showHeader && activeQuestion.multiSelect ? (
      <span className="text-xs/4 text-muted-foreground/70">Select any</span>
    ) : null;

  return (
    <Collapsible
      open={!isCollapsed}
      onOpenChange={(open) => {
        setCollapsedQuestionId(open ? null : activeQuestion.id);
      }}
    >
      {/* Expanded, the trigger shrinks to its actions and the question rises beside them.
          Its bottom margin also cancels its top margin and the banner's 4px padding, so the panel starts at the surface's top edge. */}
      <CollapsibleTrigger
        render={<ComposerBanner.Row render={<button type="button" />} />}
        className={cn(
          !isCollapsed &&
            "relative z-10 ms-auto mt-1 -mb-[calc(var(--composer-banner-icon-column)+--spacing(2))] flex w-fit",
        )}
        title={toggleLabel}
        aria-label={isCollapsed ? undefined : toggleLabel}
        data-pending-user-input-toggle={isCollapsed ? "collapsed" : "expanded"}
      >
        {isCollapsed ? (
          <>
            <ComposerBanner.Icon />
            <ComposerBanner.Content>
              {showHeader ? (
                <span className="min-w-0 truncate font-medium text-muted-foreground">
                  {activeQuestion.header}
                </span>
              ) : null}
              <span className="min-w-0 flex-1 truncate text-secondary-label">
                {activeQuestion.question}
              </span>
            </ComposerBanner.Content>
          </>
        ) : null}
        {/* The end margin puts the trailing control's center 22px in, on the option indicators' axis. */}
        <ComposerBanner.Actions className="me-1 sm:me-1.5">
          {actionsHint}
          {questionCount ? <span className={questionCountClassName}>{questionCount}</span> : null}
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
      {/* The panel cancels the banner's px-1 so the header band can reach the surface's edges; it clips its overflow.
          The vertical scrollbar keeps the inset it had inside that padding. */}
      <CollapsiblePanel className="-mx-1">
        <ComposerBanner.Scroll className="[&>[data-slot=scroll-area-scrollbar][data-orientation=vertical]]:mt-3 [&>[data-slot=scroll-area-scrollbar][data-orientation=vertical]]:mr-[5px]">
          {/* Both sides sit 16px in from the surface; the overflow scrollbar gutter takes 8px of the right. */}
          <ComposerBanner.Body className="ps-4 pe-4 pb-1 wrap-anywhere sm:ps-4 [[data-has-overflow-y]>*>&]:pe-2">
            {/* Bleeds back to the surface's sides and top, under the actions, squaring off with the surface under another attachment.
                The top inset centers the first line (16px eyebrow or 20px question) on the 28px (24px from sm) actions row. */}
            <div
              data-pending-user-input-header-band
              className={cn(
                "-mx-4 rounded-t-2xl bg-foreground/3 px-4 pb-2.5 [[data-slot=composer-banner-attachment]+[data-slot=composer-banner-attachment]_&]:rounded-t-none",
                showHeader ? "pt-3.5 sm:pt-3" : "pt-3 sm:pt-2.5",
              )}
            >
              {/* Mirrors the overlaid actions so only the first line wraps clear of them; the end margin cancels 12px of the band's 16px inset.
                  Its height matches that first line, so a 16px eyebrow does not push its second line clear too. */}
              <span
                aria-hidden
                className={cn(
                  "invisible float-end ms-2 -me-3 flex items-center gap-1 pe-1 sm:pe-1.5",
                  showHeader ? "h-4" : "h-5",
                )}
              >
                {actionsHint}
                {questionCount ? (
                  <span className={questionCountClassName}>{questionCount}</span>
                ) : null}
                <span className="w-(--composer-banner-icon-column)" />
                {prompt.dismissible ? <span className="w-(--composer-banner-icon-column)" /> : null}
              </span>
              {showHeader ? (
                <p className="text-xs/4 font-medium text-muted-foreground">
                  {activeQuestion.multiSelect
                    ? `${activeQuestion.header} · Select any`
                    : activeQuestion.header}
                </p>
              ) : null}
              <ChatMarkdown
                text={activeQuestion.question}
                cwd={cwd}
                threadRef={threadRef}
                className={cn("text-sm/5 font-medium text-foreground", showHeader && "mt-1.5")}
              />
            </div>
            {/* Row fills hang 12px past the text column so labels stay on its edge. */}
            <div className="-mx-3 mt-1.5">
              {selectableOptionEntries.map(({ option, index }, selectableIndex) => {
                const optionValue = option.value ?? option.label;
                const isOptimisticallySelected =
                  optimisticSingleSelect?.questionId === activeQuestion.id &&
                  optimisticSingleSelect.optionValue === optionValue;
                const isSelected =
                  isOptimisticallySelected || draftSelectedOptions?.[index] === true;
                return (
                  <button
                    key={`${activeQuestion.id}:${optionValue}`}
                    type="button"
                    aria-pressed={isSelected}
                    disabled={disabled || isResponding}
                    onClick={() => {
                      handleOptionSelection(activeQuestion.id, optionValue);
                    }}
                    className={cn(
                      "grid w-full grid-cols-[min(40%,16rem)_minmax(0,1fr)_--spacing(5)] items-baseline gap-x-4 rounded-lg ps-3 pe-2 py-2 text-left outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/40",
                      "@max-[480px]:grid-cols-[minmax(0,1fr)_--spacing(5)] @max-[480px]:gap-y-0.5",
                      isSelected ? "bg-foreground/8" : "bg-transparent hover:bg-foreground/4",
                      (disabled || isResponding) && "opacity-50 cursor-not-allowed",
                      !disabled && !isResponding && "cursor-pointer",
                    )}
                  >
                    <span
                      className={cn(
                        "col-start-1 row-start-1 text-sm/5",
                        isSelected ? "text-foreground" : "text-foreground/90",
                      )}
                    >
                      {option.label}
                    </span>
                    {/* Stays as an empty cell without a description so the columns never shift.
                        Baseline alignment drops 12px text a pixel below the 14px label's box; the margin keeps rows 36px. */}
                    <span className="col-start-2 row-start-1 -mb-px text-xs/5 text-muted-foreground @max-[480px]:col-start-1 @max-[480px]:row-start-2 @max-[480px]:mb-0 @max-[480px]:text-xs/4 @max-[480px]:empty:hidden">
                      {option.description && option.description !== option.label
                        ? option.description
                        : null}
                    </span>
                    {/* The number and the check share one fixed box so selecting never resizes the row. */}
                    <span
                      data-pending-user-input-option-key
                      className="col-start-3 row-start-1 flex size-5 items-center justify-center self-start text-xs/5 font-medium text-muted-foreground/60 tabular-nums @max-[480px]:col-start-2"
                    >
                      {isSelected ? (
                        <CheckIcon aria-hidden className="size-4 text-primary" strokeWidth={2.5} />
                      ) : selectableIndex < 9 ? (
                        selectableIndex + 1
                      ) : null}
                    </span>
                  </button>
                );
              })}
              {customAnswerOptions.map((option) => {
                const optionValue = option.value ?? option.label;
                return (
                  <div
                    key={`${activeQuestion.id}:custom-answer:${optionValue}`}
                    data-pending-user-input-custom-answer-option
                    className={cn(
                      "grid w-full grid-cols-[min(40%,16rem)_minmax(0,1fr)_--spacing(5)] items-baseline gap-x-4 rounded-lg ps-3 pe-2 py-2 text-left",
                      "@max-[480px]:grid-cols-[minmax(0,1fr)_--spacing(5)] @max-[480px]:gap-y-0.5",
                      (disabled || isResponding) && "opacity-50",
                    )}
                  >
                    <span className="col-start-1 row-start-1 text-sm/5 text-foreground/90">
                      {option.label}
                    </span>
                    <span className="col-start-2 row-start-1 -mb-px text-xs/5 text-muted-foreground @max-[480px]:col-start-1 @max-[480px]:row-start-2 @max-[480px]:mb-0 @max-[480px]:text-xs/4 @max-[480px]:empty:hidden">
                      {option.description && option.description !== option.label
                        ? option.description
                        : null}
                    </span>
                    <span className="col-start-3 row-start-1 flex size-5 items-center justify-center self-start text-muted-foreground/60 @max-[480px]:col-start-2">
                      <ArrowDownIcon aria-hidden className="size-4" strokeWidth={2.5} />
                    </span>
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
