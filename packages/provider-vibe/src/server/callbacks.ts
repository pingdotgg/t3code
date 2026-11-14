import type {
  OrchestrationV2UserInputQuestion,
  ProviderUserInputAnswers,
} from "@t3tools/contracts";

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

export function vibeCallback(params: unknown) {
  const callback = record(record(params)?.["callback"]);
  const callbackId = text(callback?.["callbackId"]);
  const detail = record(callback?.["detail"]);
  const kind = detail?.["kind"];
  if (!callbackId || (kind !== "approval" && kind !== "user_input")) return undefined;
  const questions: OrchestrationV2UserInputQuestion[] = [];
  if (kind === "user_input") {
    const request = record(detail?.["request"]);
    if (!Array.isArray(request?.["questions"])) return undefined;
    for (const [index, value] of request["questions"].entries()) {
      const question = record(value);
      const prompt = text(question?.["question"]);
      if (!prompt || !Array.isArray(question?.["options"])) return undefined;
      const options: OrchestrationV2UserInputQuestion["options"][number][] = [];
      for (const value of question["options"]) {
        const option = record(value);
        const label = text(option?.["label"]);
        if (!label) return undefined;
        options.push({ label, description: text(option?.["description"]) ?? label });
      }
      questions.push({
        id: `question-${index}`,
        header: text(question?.["header"]) ?? `Question ${index + 1}`,
        question: prompt,
        options,
        multiSelect: question["multiSelect"] === true,
        allowCustomAnswer: question["hideOther"] !== true,
      });
    }
    if (questions.length === 0) return undefined;
  }
  return {
    callbackId,
    kind: kind === "user_input" ? ("user_input" as const) : ("permission" as const),
    questions,
  };
}

export function vibeQuestionResult(
  questions: ReadonlyArray<OrchestrationV2UserInputQuestion>,
  answers: ProviderUserInputAnswers,
  cancelled: boolean,
) {
  return {
    type: "user_input" as const,
    result: {
      answers: cancelled
        ? []
        : questions.map((question) => {
            const value = answers[question.id];
            const answer = Array.isArray(value) ? value.join(", ") : String(value ?? "");
            return {
              question: question.question,
              answer,
              isOther:
                !question.options.some((option) => option.label === answer) &&
                !Array.isArray(value),
            };
          }),
      cancelled,
    },
  };
}
