import type { ApprovalRequestId, UserInputQuestion } from "@t3tools/contracts";
import {
  resolvePendingUserInputAnswer,
  type PendingUserInputDraftAnswer,
  type PendingUserInputProgress,
} from "@t3tools/client-runtime";
import { memo, useCallback, useEffect, useRef } from "react";
import { Keyboard, Pressable, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { cn } from "../../lib/cn";
import type { PendingUserInput } from "../../lib/threadActivity";

export interface PendingUserInputPanelProps {
  readonly pendingUserInput: PendingUserInput;
  readonly drafts: Record<string, PendingUserInputDraftAnswer>;
  readonly progress: PendingUserInputProgress | null;
  readonly respondingUserInputId: ApprovalRequestId | null;
  readonly onSelectOption: (
    requestId: string,
    questionId: string,
    question: UserInputQuestion,
    label: string,
  ) => void;
  readonly onChangeCustomAnswer: (
    requestId: string,
    questionId: string,
    customAnswer: string,
  ) => void;
  readonly onAdvance: () => void;
  readonly onGoBack: () => void;
  readonly onSetQuestionIndex: (index: number) => void;
  readonly onSubmit: () => Promise<void>;
}

export const PendingUserInputPanel = memo(function PendingUserInputPanel(
  props: PendingUserInputPanelProps,
) {
  const { pendingUserInput, progress, onAdvance, onSelectOption } = props;
  const isResponding = props.respondingUserInputId === pendingUserInput.requestId;
  const questions = pendingUserInput.questions;
  const autoAdvanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onAdvanceRef = useRef(onAdvance);

  useEffect(() => {
    onAdvanceRef.current = onAdvance;
  }, [onAdvance]);

  // Clear auto-advance timer on unmount
  useEffect(() => {
    return () => {
      if (autoAdvanceTimerRef.current !== null) {
        clearTimeout(autoAdvanceTimerRef.current);
      }
    };
  }, []);

  const handleOptionSelection = useCallback(
    (questionId: string, question: UserInputQuestion, optionLabel: string) => {
      Keyboard.dismiss();
      onSelectOption(pendingUserInput.requestId, questionId, question, optionLabel);

      // Auto-advance for single-select questions after 200ms
      if (question.multiSelect) {
        return;
      }

      if (autoAdvanceTimerRef.current !== null) {
        clearTimeout(autoAdvanceTimerRef.current);
      }

      autoAdvanceTimerRef.current = setTimeout(() => {
        autoAdvanceTimerRef.current = null;
        onAdvanceRef.current();
      }, 200);
    },
    [onSelectOption, pendingUserInput.requestId],
  );

  if (!progress) {
    return null;
  }

  const { activeQuestion, questionIndex } = progress;

  const isPastLastQuestion = questionIndex >= questions.length;

  if (isPastLastQuestion) {
    return (
      <SummaryView
        pendingUserInput={pendingUserInput}
        drafts={props.drafts}
        progress={progress}
        isResponding={isResponding}
        onGoBack={props.onGoBack}
        onSetQuestionIndex={props.onSetQuestionIndex}
        onSubmit={props.onSubmit}
      />
    );
  }

  if (!activeQuestion) {
    return null;
  }

  return (
    <Pressable onPress={Keyboard.dismiss}>
      <View className="gap-2.5 rounded-[20px] border border-border bg-card p-4">
        <View className="flex-row items-center justify-between">
          <Text className="font-t3-bold text-[11px] uppercase tracking-[1.1px] text-sky-700 dark:text-sky-300">
            User input needed
          </Text>
          {questions.length > 1 ? (
            <Text className="font-t3-medium text-[11px] tabular-nums text-neutral-500 dark:text-neutral-500">
              {progress.questionIndex + 1}/{questions.length}
            </Text>
          ) : null}
        </View>

        <View className="gap-2">
          <Text className="font-t3-bold text-xs uppercase tracking-[1px] text-neutral-500 dark:text-neutral-500">
            {activeQuestion.header}
          </Text>
          <Text className="font-sans text-[15px] leading-[21px] text-foreground">
            {activeQuestion.question}
          </Text>
          {activeQuestion.multiSelect ? (
            <Text className="font-sans text-[13px] text-foreground-muted">
              Select one or more
            </Text>
          ) : null}
        </View>

        <View className="gap-2">
          {activeQuestion.options.map((option) => {
            const isSelected =
              !progress.usingCustomAnswer &&
              progress.selectedOptionLabels.includes(option.label);
            const showDescription =
              option.description && option.description !== option.label;

            return (
              <Pressable
                key={option.label}
                disabled={isResponding}
                className={cn(
                  "flex-row items-center rounded-2xl border px-3.5 py-3",
                  isSelected
                    ? "border-blue-300/50 bg-blue-50 dark:border-blue-400/28 dark:bg-blue-400/14"
                    : "border-border bg-card",
                  isResponding && "opacity-50",
                )}
                onPress={() =>
                  handleOptionSelection(activeQuestion.id, activeQuestion, option.label)
                }
              >
                <View className="flex-1 gap-0.5">
                  <Text
                    className={cn(
                      "font-t3-bold text-[13px]",
                      isSelected
                        ? "text-sky-700 dark:text-sky-300"
                        : "text-foreground-muted",
                    )}
                  >
                    {option.label}
                  </Text>
                  {showDescription ? (
                    <Text
                      className="font-sans text-[12px] leading-[16px] text-foreground-muted"
                      numberOfLines={3}
                    >
                      {option.description}
                    </Text>
                  ) : null}
                </View>
                {isSelected ? (
                  <View className="ml-2">
                    <CheckmarkIcon />
                  </View>
                ) : null}
              </Pressable>
            );
          })}
        </View>

        <TextInput
          value={progress.customAnswer}
          onChangeText={(value) =>
            props.onChangeCustomAnswer(pendingUserInput.requestId, activeQuestion.id, value)
          }
          placeholder="Or type a custom answer"
          editable={!isResponding}
          className="min-h-[54px] rounded-2xl border border-border bg-card px-3.5 py-3 font-sans text-[15px] text-foreground"
        />

        <NavigationControls
          questionIndex={progress.questionIndex}
          questionCount={questions.length}
          canAdvance={progress.canAdvance}
          isMultiSelect={!!activeQuestion.multiSelect}
          usingCustomAnswer={progress.usingCustomAnswer}
          isResponding={isResponding}
          onGoBack={props.onGoBack}
          onAdvance={props.onAdvance}
        />
      </View>
    </Pressable>
  );
});

// ---------------------------------------------------------------------------
// Navigation Controls
// ---------------------------------------------------------------------------

const NavigationControls = memo(function NavigationControls(props: {
  readonly questionIndex: number;
  readonly questionCount: number;
  readonly canAdvance: boolean;
  readonly isMultiSelect: boolean;
  readonly usingCustomAnswer: boolean;
  readonly isResponding: boolean;
  readonly onGoBack: () => void;
  readonly onAdvance: () => void;
}) {
  const {
    questionIndex,
    questionCount,
    canAdvance,
    isMultiSelect,
    usingCustomAnswer,
    isResponding,
    onGoBack,
    onAdvance,
  } = props;

  const showBackButton = questionIndex > 0;
  const showNextButton = isMultiSelect || usingCustomAnswer;
  const isSingleQuestion = questionCount === 1;

  const handleGoBack = useCallback(() => {
    Keyboard.dismiss();
    onGoBack();
  }, [onGoBack]);

  const handleAdvance = useCallback(() => {
    Keyboard.dismiss();
    onAdvance();
  }, [onAdvance]);

  if (isSingleQuestion && !showNextButton) {
    return null;
  }

  return (
    <View className="flex-row items-center gap-2">
      {showBackButton ? (
        <Pressable
          className="flex-row items-center justify-center rounded-2xl border border-border px-4 py-3"
          disabled={isResponding}
          onPress={handleGoBack}
        >
          <Text className="font-t3-bold text-sm text-foreground-muted">
            Back
          </Text>
        </Pressable>
      ) : null}

      {showNextButton ? (
        <Pressable
          className={cn(
            "flex-1 items-center justify-center rounded-2xl px-4 py-3",
            canAdvance ? "bg-blue-500" : "bg-subtle",
          )}
          disabled={!canAdvance || isResponding}
          onPress={handleAdvance}
        >
          <Text className="font-t3-extrabold text-sm text-white">Next</Text>
        </Pressable>
      ) : null}
    </View>
  );
});

// ---------------------------------------------------------------------------
// Summary View
// ---------------------------------------------------------------------------

const SummaryView = memo(function SummaryView(props: {
  readonly pendingUserInput: PendingUserInput;
  readonly drafts: Record<string, PendingUserInputDraftAnswer>;
  readonly progress: PendingUserInputProgress;
  readonly isResponding: boolean;
  readonly onGoBack: () => void;
  readonly onSetQuestionIndex: (index: number) => void;
  readonly onSubmit: () => Promise<void>;
}) {
  const { pendingUserInput, drafts, isResponding, onGoBack, onSetQuestionIndex, onSubmit } = props;

  return (
    <View className="gap-2.5 rounded-[20px] border border-border bg-card p-4">
      <Text className="font-t3-bold text-[11px] uppercase tracking-[1.1px] text-sky-700 dark:text-sky-300">
        Review answers
      </Text>
      <Text className="font-t3-bold text-lg text-foreground">
        Confirm your answers
      </Text>

      <View className="gap-3">
        {pendingUserInput.questions.map((question, index) => {
          const draft = drafts[question.id];
          const answer = resolveDisplayAnswer(question, draft);

          return (
            <Pressable
              key={question.id}
              disabled={isResponding}
              className="gap-1 rounded-2xl border border-border bg-subtle px-3.5 py-3"
              onPress={() => onSetQuestionIndex(index)}
            >
              <Text className="font-t3-bold text-[11px] uppercase tracking-[0.5px] text-foreground-muted">
                {question.header}
              </Text>
              <Text className="font-t3-medium text-[14px] text-foreground">
                {answer}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View className="flex-row items-center gap-2">
        <Pressable
          className="flex-row items-center justify-center rounded-2xl border border-border px-4 py-3.5"
          disabled={isResponding}
          onPress={onGoBack}
        >
          <Text className="font-t3-bold text-sm text-foreground-muted">
            Back
          </Text>
        </Pressable>

        <Pressable
          className={cn(
            "flex-1 items-center justify-center rounded-2xl px-4 py-3.5",
            props.progress.isComplete ? "bg-blue-500" : "bg-subtle",
          )}
          disabled={!props.progress.isComplete || isResponding}
          onPress={() => void onSubmit()}
        >
          <Text className="font-t3-extrabold text-sm text-white">
            {isResponding ? "Submitting..." : "Submit answers"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveDisplayAnswer(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
): string {
  const answer = resolvePendingUserInputAnswer(question, draft);
  if (answer === null) {
    return "No answer";
  }
  return Array.isArray(answer) ? answer.join(", ") : answer;
}

function CheckmarkIcon() {
  return (
    <View className="h-4 w-4 items-center justify-center rounded-full bg-blue-500">
      <Text className="font-t3-extrabold text-[10px] leading-[10px] text-white">
        {"\u2713"}
      </Text>
    </View>
  );
}
