import {
  cardAnswerMessage,
  quizAnswerMessage,
  quizRevealWrongIdeas,
  shuffledQuizOptions,
  type QuizCard as QuizCardData,
} from "@t3tools/shared/quizCard";
import { CommandId, MessageId, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";
import { uuidv4 } from "../../lib/uuid";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";

export function QuizCard(props: {
  readonly quizCard: QuizCardData;
  readonly seed: string;
  readonly answered: boolean;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const options = shuffledQuizOptions(props.quizCard, props.seed);
  const [selected, setSelected] = useState<string | null>(null);
  const [confidence, setConfidence] = useState(50);
  const [thinking, setThinking] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revealed = props.answered || submitted;
  const picked = options.find((option) => option.option === selected);
  const sentPick = submitted ? picked : undefined;
  const wrongOptions = quizRevealWrongIdeas(options);

  const submit = async () => {
    if (sending || revealed || selected === null) return;
    setSending(true);
    setError(null);
    const answer = selected === "__unknown__" ? null : selected;
    const message = cardAnswerMessage(
      quizAnswerMessage({ answer, correct: picked?.correct === true, confidence, thinking }),
      props.seed,
    );
    try {
      await enqueueThreadOutboxMessage({
        environmentId: props.environmentId,
        threadId: props.threadId,
        messageId: MessageId.make(uuidv4()),
        commandId: CommandId.make(uuidv4()),
        text: message,
        attachments: [],
        dispatchMode: "queue",
        createdAt: new Date().toISOString(),
      });
      setSubmitted(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send your answer.");
    }
    setSending(false);
  };

  return (
    <View className="mb-3 rounded-2xl border border-border bg-card p-4">
      <Text className="font-t3-medium text-base">{props.quizCard.question}</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel="Answer" className="mt-3 gap-2">
        {options.map((option) => (
          <Pressable
            key={option.option}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected === option.option, disabled: revealed }}
            disabled={revealed || sending}
            onPress={() => setSelected(option.option)}
            className={cn(
              "rounded-xl border px-3 py-3",
              selected === option.option ? "border-primary bg-primary/10" : "border-border",
            )}
          >
            <Text>
              {option.option}
              {revealed && option.correct ? " (right)" : ""}
            </Text>
          </Pressable>
        ))}
        <Pressable
          accessibilityRole="radio"
          accessibilityState={{ checked: selected === "__unknown__", disabled: revealed }}
          disabled={revealed || sending}
          onPress={() => setSelected("__unknown__")}
          className={cn(
            "rounded-xl border px-3 py-3",
            selected === "__unknown__" ? "border-primary bg-primary/10" : "border-border",
          )}
        >
          <Text>I don't know</Text>
        </Pressable>
      </View>
      {!revealed ? (
        <>
          {selected === "__unknown__" ? null : (
            <View className="mt-4 gap-2">
              <Text className="font-t3-medium text-sm">How sure are you? {confidence}%</Text>
              <View
                accessibilityRole="radiogroup"
                accessibilityLabel="How sure are you?"
                className="flex-row gap-2"
              >
                {[0, 25, 50, 75, 100].map((value) => (
                  <Pressable
                    key={value}
                    accessibilityRole="radio"
                    accessibilityLabel={`${value} percent`}
                    accessibilityState={{ checked: confidence === value }}
                    disabled={sending}
                    onPress={() => setConfidence(value)}
                    className={cn(
                      "flex-1 items-center rounded-lg border px-1 py-2",
                      confidence === value ? "border-primary bg-primary/10" : "border-border",
                    )}
                  >
                    <Text className="text-xs">{value}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}
          <Text className="mt-3 font-t3-medium text-sm">Your thinking (optional)</Text>
          <TextInput
            value={thinking}
            onChangeText={setThinking}
            editable={!sending}
            multiline
            accessibilityLabel="Your thinking (optional)"
            className="mt-2 min-h-20"
          />
          <Button
            label="Submit"
            onPress={() => void submit()}
            disabled={sending || selected === null}
            loading={sending}
            tone="primary"
            size="compact"
          />
          {error ? (
            <Text accessibilityRole="alert" className="mt-2 text-sm text-danger">
              {error}
            </Text>
          ) : null}
        </>
      ) : (
        <View className="mt-4 gap-2">
          <Text
            className={
              picked === undefined
                ? "text-foreground"
                : picked.correct
                  ? "text-success"
                  : "text-danger"
            }
          >
            {sentPick === undefined
              ? submitted
                ? "I don't know."
                : "Answered."
              : sentPick.correct
                ? "Right."
                : "Wrong."}
          </Text>
          <Text>{props.quizCard.explanation}</Text>
          {wrongOptions.map((option) => (
            <Text key={option.option}>
              <Text className="font-t3-medium">{option.label}</Text> {option.wrongIdea}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}
