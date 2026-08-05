import type { ApprovalRequestId } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { cn } from "../../lib/cn";
import type { PendingUserInput, PendingUserInputDraftAnswer } from "../../lib/threadActivity";
import { useThemeColor } from "../../lib/useThemeColor";

export interface PendingUserInputCardProps {
  readonly pendingUserInput: PendingUserInput;
  readonly drafts: Record<string, PendingUserInputDraftAnswer>;
  readonly answers: Record<string, string> | null;
  readonly respondingUserInputId: ApprovalRequestId | null;
  readonly onSelectOption: (
    requestId: ApprovalRequestId,
    questionId: string,
    label: string,
  ) => void;
  readonly onChangeCustomAnswer: (
    requestId: ApprovalRequestId,
    questionId: string,
    customAnswer: string,
  ) => void;
  readonly onSubmit: () => Promise<unknown>;
}

function hasDraftAnswer(draft: PendingUserInputDraftAnswer | undefined): boolean {
  return Boolean(draft?.customAnswer?.trim() || draft?.selectedOptionLabel?.trim());
}

function firstUnansweredQuestionIndex(
  questions: PendingUserInput["questions"],
  drafts: Record<string, PendingUserInputDraftAnswer>,
): number {
  const index = questions.findIndex((question) => !hasDraftAnswer(drafts[question.id]));
  return index === -1 ? Math.max(questions.length - 1, 0) : index;
}

export function PendingUserInputCard(props: PendingUserInputCardProps) {
  const [questionIndex, setQuestionIndex] = useState(() =>
    firstUnansweredQuestionIndex(props.pendingUserInput.questions, props.drafts),
  );
  const selectedColor = useThemeColor("--color-md-link");
  const activeQuestion = props.pendingUserInput.questions[questionIndex] ?? null;
  const draft = activeQuestion ? props.drafts[activeQuestion.id] : undefined;
  const isResponding = props.respondingUserInputId === props.pendingUserInput.requestId;
  const isLastQuestion = questionIndex >= props.pendingUserInput.questions.length - 1;
  const canGoBack = questionIndex > 0 && !isResponding;
  const canAdvance = hasDraftAnswer(draft);
  const canContinue = isLastQuestion ? props.answers !== null : canAdvance;

  if (!activeQuestion) {
    return null;
  }

  const handleAdvance = () => {
    if (!canContinue || isResponding) {
      return;
    }
    if (!isLastQuestion) {
      setQuestionIndex((current) =>
        Math.min(current + 1, props.pendingUserInput.questions.length - 1),
      );
      return;
    }
    if (props.answers) {
      void props.onSubmit();
    }
  };

  const handleBack = () => {
    if (!canGoBack) return;
    setQuestionIndex((current) => Math.max(0, current - 1));
  };

  return (
    <View
      accessibilityLabel={`Input needed: ${activeQuestion.question}`}
      className="overflow-hidden rounded-[22px] border border-border bg-card"
    >
      <View className="gap-2 px-4 pb-3 pt-3.5">
        <View className="flex-row items-center justify-between gap-3">
          <Text
            numberOfLines={1}
            className="min-w-0 flex-1 font-t3-bold text-2xs uppercase tracking-[1.2px] text-indigo-600 dark:text-indigo-300"
          >
            {activeQuestion.header}
          </Text>
          <Text className="font-t3-medium text-sm tabular-nums text-foreground-tertiary">
            {questionIndex + 1}/{props.pendingUserInput.questions.length}
          </Text>
        </View>
        <Text className="font-t3-bold text-lg leading-[24px] text-foreground">
          {activeQuestion.question}
        </Text>
      </View>

      <View className="gap-1.5 border-t border-border px-3 py-2.5">
        {activeQuestion.options.map((option, index) => {
          const selected =
            draft?.selectedOptionLabel === option.label && !draft.customAnswer?.trim().length;
          return (
            <Pressable
              key={option.label}
              accessibilityLabel={`${option.label}. ${option.description}`}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected, disabled: isResponding }}
              className={cn(
                "min-h-[68px] flex-row items-center gap-3 rounded-xl border px-3 py-3",
                selected ? "border-blue-500/45 bg-blue-500/10" : "border-transparent bg-subtle",
                isResponding && "opacity-50",
              )}
              disabled={isResponding}
              onPress={() =>
                props.onSelectOption(
                  props.pendingUserInput.requestId,
                  activeQuestion.id,
                  option.label,
                )
              }
            >
              <View className="min-w-0 flex-1 gap-0.5">
                <Text className="font-t3-bold text-base text-foreground">{option.label}</Text>
                {option.description !== option.label ? (
                  <Text className="font-sans text-sm leading-[19px] text-foreground-muted">
                    {option.description}
                  </Text>
                ) : null}
              </View>
              {selected ? (
                <SymbolView
                  name="checkmark"
                  size={16}
                  tintColor={selectedColor}
                  type="monochrome"
                />
              ) : index < 9 ? (
                <View className="size-6 items-center justify-center rounded-md border border-border bg-screen/40">
                  <Text className="font-t3-medium text-xs tabular-nums text-foreground-muted">
                    {index + 1}
                  </Text>
                </View>
              ) : null}
            </Pressable>
          );
        })}

        <TextInput
          accessibilityLabel="Write a custom answer"
          editable={!isResponding}
          value={draft?.customAnswer ?? ""}
          onChangeText={(value) =>
            props.onChangeCustomAnswer(props.pendingUserInput.requestId, activeQuestion.id, value)
          }
          placeholder="Write a different answer"
          selectionColor={selectedColor}
          className="mt-1 min-h-12 rounded-xl bg-screen px-3 py-3 text-base"
        />
      </View>

      <View className="flex-row items-center justify-between border-t border-border px-3 py-2.5">
        {questionIndex > 0 ? (
          <Pressable
            accessibilityLabel="Previous question"
            accessibilityRole="button"
            accessibilityState={{ disabled: !canGoBack }}
            className={cn("min-h-11 items-center justify-center px-3", !canGoBack && "opacity-50")}
            disabled={!canGoBack}
            onPress={handleBack}
          >
            <Text className="font-t3-bold text-base text-foreground-muted">Back</Text>
          </Pressable>
        ) : (
          <View />
        )}
        <Pressable
          accessibilityLabel={isLastQuestion ? "Submit answers" : "Next question"}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canContinue || isResponding }}
          className={cn(
            "min-h-11 items-center justify-center rounded-full px-5",
            canContinue && !isResponding ? "bg-blue-600" : "bg-subtle-strong",
          )}
          disabled={!canContinue || isResponding}
          onPress={handleAdvance}
        >
          <Text
            className={cn(
              "font-t3-bold text-base",
              canContinue && !isResponding ? "text-white" : "text-foreground-tertiary",
            )}
          >
            {isLastQuestion ? "Submit answers" : "Next question"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
