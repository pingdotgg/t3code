import { type RuntimeRequestId, type ScopedThreadRef } from "@t3tools/contracts";
import { memo, use, useEffect, useEffectEvent, useId, useRef, useState } from "react";
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
  const advance = useStableCallback(onAdvance);
  const [optimisticSingleSelect, setOptimisticSingleSelect] = useState<{
    questionId: string;
    optionValue: string;
  } | null>(null);
  const [collapsedQuestionId, setCollapsedQuestionId] = useState<string | null>(null);
  // Keep question identity stable for its shortcut listener.
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);
  const optionIdPrefix = useId();
  const headerId = optionIdPrefix + "-header";
  const previewId = optionIdPrefix + "-preview";
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

  const selectOptionFromShortcut = useEffectEvent(handleOptionSelection);
  const backgroundThread = use(BackgroundThreadContext);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes a document keydown listener for digit shortcuts while a question is answerable
  useEffect(() => {
    if (!activeQuestion || responseDisabled || isCollapsed || backgroundThread) return;
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
      selectOptionFromShortcut(activeQuestion.id, option.value ?? option.label);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeQuestion, backgroundThread, isCollapsed, responseDisabled]);

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
      <ComposerBanner.Row className="relative px-4 pt-1.5">
        <CollapsibleTrigger
          render={<button type="button" />}
          aria-labelledby={headerId}
          aria-describedby={isCollapsed ? previewId : undefined}
          title={
            isCollapsed ? "Show the question and its options" : "Hide the question and its options"
          }
          data-pending-user-input-toggle={isCollapsed ? "collapsed" : "expanded"}
          className="absolute inset-0 cursor-pointer rounded-md focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        />
        <ComposerBanner.Content className="pointer-events-none relative">
          <span id={headerId} className="shrink-0 text-muted-foreground">
            {activeQuestion.header}
          </span>
          {isCollapsed ? (
            <>
              <ComposerBanner.Separator />
              <span id={previewId} inert className="min-w-0 flex-1" data-pending-user-input-preview>
                <ChatMarkdown
                  text={activeQuestion.question}
                  cwd={cwd}
                  threadRef={threadRef}
                  parseRawHtml={false}
                  className="line-clamp-1 max-h-lh text-xs/4 text-secondary-label [&>p]:inline [&>p]:after:content-['_']"
                />
              </span>
            </>
          ) : null}
        </ComposerBanner.Content>
        <ComposerBanner.Actions className="pointer-events-none relative gap-0">
          {prompt.questions.length > 1 ? (
            <ComposerBanner.Count>
              {questionIndex + 1}/{prompt.questions.length}
            </ComposerBanner.Count>
          ) : null}
          <ComposerBanner.ToggleIcon expanded={!isCollapsed} />
          {prompt.dismissible ? (
            <span className="pointer-events-auto self-stretch inline-flex">
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
          <ComposerBanner.Body className="ps-6 pe-4 pb-1 wrap-anywhere sm:ps-5.5">
            <ChatMarkdown
              text={activeQuestion.question}
              cwd={cwd}
              threadRef={threadRef}
              className="pt-2 text-foreground/85"
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
                const labelId = optionIdPrefix + "-" + index + "-label";
                const descriptionId = optionIdPrefix + "-" + index + "-description";
                const hasDescription = option.description && option.description !== option.label;
                return (
                  <div
                    key={activeQuestion.id + ":" + optionValue}
                    className={cn(
                      "group relative flex w-full items-start gap-2.5 rounded-md bg-transparent py-1.5 ps-2 text-left sm:ps-1.5 transition-colors duration-150 has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-primary/25",
                      isSelected ? "text-foreground" : "text-foreground/70 hover:bg-muted/30",
                      (disabled || isResponding) && "opacity-50 cursor-not-allowed",
                    )}
                  >
                    <button
                      type="button"
                      aria-labelledby={labelId}
                      aria-describedby={hasDescription ? descriptionId : undefined}
                      aria-pressed={isSelected}
                      disabled={disabled || isResponding}
                      className="absolute inset-0 cursor-pointer rounded-md outline-none disabled:cursor-not-allowed"
                      onClick={() => handleOptionSelection(activeQuestion.id, optionValue)}
                    />
                    <span className="pointer-events-none relative flex h-5 shrink-0 items-center">
                      {activeQuestion.multiSelect ? (
                        <CheckboxMark checked={isSelected} />
                      ) : (
                        <OptionRadio checked={isSelected} />
                      )}
                    </span>
                    <div className="pointer-events-none relative min-w-0 flex-1 flex flex-col gap-0.5 [&_a]:pointer-events-auto [&_button]:pointer-events-auto [&_[role=button]]:pointer-events-auto [&_[role=link]]:pointer-events-auto [&_input]:pointer-events-auto [&_summary]:pointer-events-auto [&_video]:pointer-events-auto [&_audio]:pointer-events-auto [&_pre]:pointer-events-auto [&_.overflow-x-auto]:pointer-events-auto [&_[data-slot^=scroll-area-]]:pointer-events-auto">
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
                    {index < 9 ? (
                      <span className="pointer-events-none relative flex h-5 w-7 shrink-0 items-center justify-center sm:w-6">
                        <Kbd>{index + 1}</Kbd>
                      </span>
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
        "relative inline-flex size-4.5 shrink-0 items-center justify-center rounded-full border border-input bg-background not-dark:bg-clip-padding sm:size-4 dark:bg-input/32",
        checked ? "shadow-none" : "shadow-xs/5",
      )}
    >
      {checked ? (
        <span className="-inset-px absolute flex items-center justify-center rounded-full bg-primary before:size-2 before:rounded-full before:bg-primary-foreground sm:before:size-1.5" />
      ) : null}
    </span>
  );
}
