import type { ApprovalRequestId } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { cx } from "../../lib/classNames";
import type { PendingUserInput, PendingUserInputDraftAnswer } from "../../lib/threadActivity";

export interface PendingUserInputCardProps {
  readonly pendingUserInput: PendingUserInput;
  readonly drafts: Record<string, PendingUserInputDraftAnswer>;
  readonly answers: Record<string, string> | null;
  readonly respondingUserInputId: ApprovalRequestId | null;
  readonly onSelectOption: (requestId: string, questionId: string, label: string) => void;
  readonly onChangeCustomAnswer: (
    requestId: string,
    questionId: string,
    customAnswer: string,
  ) => void;
  readonly onSubmit: () => Promise<void>;
}

export function PendingUserInputCard(props: PendingUserInputCardProps) {
  return (
    <View className="gap-2.5 rounded-[20px] border border-slate-200 bg-slate-100/80 p-4 dark:border-white/6 dark:bg-slate-900/80">
      <Text className="font-t3-bold text-[11px] uppercase tracking-[1.1px] text-orange-600 dark:text-orange-300">
        User input needed
      </Text>
      <Text className="font-t3-bold text-lg text-slate-950 dark:text-slate-50">
        Fill in the pending answers
      </Text>
      {props.pendingUserInput.questions.map((question) => {
        const draft = props.drafts[question.id];
        return (
          <View key={question.id} className="gap-2 pt-1">
            <Text className="font-t3-bold text-xs uppercase tracking-[1px] text-slate-500 dark:text-slate-500">
              {question.header}
            </Text>
            <Text className="font-sans text-[15px] leading-[21px] text-slate-950 dark:text-slate-50">
              {question.question}
            </Text>
            <View className="flex-row flex-wrap gap-2.5">
              {question.options.map((option) => {
                const selected =
                  draft?.selectedOptionLabel === option.label && !draft.customAnswer?.trim().length;
                return (
                  <Pressable
                    key={option.label}
                    className={cx(
                      "rounded-full border px-3 py-2.5",
                      selected
                        ? "border-orange-300/60 bg-orange-100 dark:border-orange-300/28 dark:bg-orange-300/16"
                        : "border-slate-200 bg-white dark:border-white/6 dark:bg-slate-950/70",
                    )}
                    onPress={() =>
                      props.onSelectOption(
                        props.pendingUserInput.requestId,
                        question.id,
                        option.label,
                      )
                    }
                  >
                    <Text
                      className={cx(
                        "font-t3-bold text-[13px]",
                        selected
                          ? "text-orange-700 dark:text-orange-300"
                          : "text-slate-600 dark:text-slate-300",
                      )}
                    >
                      {option.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <TextInput
              value={draft?.customAnswer ?? ""}
              onChangeText={(value) =>
                props.onChangeCustomAnswer(props.pendingUserInput.requestId, question.id, value)
              }
              placeholder="Or type a custom answer"
              className="min-h-[54px] rounded-2xl border border-slate-200 bg-white px-3.5 py-3 font-sans text-[15px] text-slate-950 dark:border-white/8 dark:bg-slate-950/70 dark:text-slate-50"
            />
          </View>
        );
      })}
      <Pressable
        className={cx(
          "items-center justify-center rounded-2xl px-4 py-3.5",
          props.answers ? "bg-orange-500" : "bg-slate-200 dark:bg-slate-700/60",
        )}
        disabled={
          props.answers === null || props.respondingUserInputId === props.pendingUserInput.requestId
        }
        onPress={() => void props.onSubmit()}
      >
        <Text className="font-t3-extrabold text-sm text-white">Submit answers</Text>
      </Pressable>
    </View>
  );
}
