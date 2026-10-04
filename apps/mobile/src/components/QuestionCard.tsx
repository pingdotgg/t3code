import { useState } from "react";
import { View } from "react-native";
import type { UserInputRequest } from "../../../../packages/protocol/src/index.ts";
import { AppText as Text, AppTextInput } from "./AppText";
import { RequestActionButton } from "./RequestActionButton";

export function QuestionCard({ request, connected, onRespond }: {
  request: UserInputRequest; connected: boolean; onRespond: (answers: Record<string, string[]>) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  return <View className="gap-3 rounded-[20px] border border-border bg-card-alt p-4">
    {request.questions.map((question) => <View key={question.id} className="gap-2">
      <Text className="font-t3-bold text-sm">{question.header || "Codex needs your input"}</Text>
      <Text>{question.question}</Text>
      {question.options?.map((option) => <RequestActionButton key={option.label} tone="secondary" label={option.label}
        disabled={busy || !connected} onPress={() => setAnswers({ ...answers, [question.id]: option.label })} />)}
      <AppTextInput accessibilityLabel={question.question} value={answers[question.id] ?? ""}
        onChangeText={(value) => setAnswers({ ...answers, [question.id]: value })} placeholder="Your answer" />
    </View>)}
    <RequestActionButton label="Answer" disabled={busy || !connected || request.questions.some((q) => !answers[q.id]?.trim())}
      onPress={() => { setBusy(true); void onRespond(Object.fromEntries(Object.entries(answers).map(([id, value]) => [id, [value]]))).finally(() => setBusy(false)); }} />
  </View>;
}
