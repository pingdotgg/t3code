import type { OrchestrationV2UserInputQuestion } from "@t3tools/contracts";

export function formatAsyncUserInputAnswer(
  question: OrchestrationV2UserInputQuestion,
  answer: string | ReadonlyArray<string>,
): string {
  const values = typeof answer === "string" ? [answer] : answer;
  const selectsOptions = values.every((value) =>
    question.options.some((option) =>
      option.value === undefined ? option.label.trim() === value.trim() : option.value === value,
    ),
  );
  const label =
    question.options.length === 0
      ? "User answer"
      : selectsOptions
        ? values.length === 1
          ? "Selected option"
          : "Selected options"
        : "Custom answer (instead of the listed options)";
  return `Question (from assistant):\n${question.question}\n\n${label}:\n${values.join(", ").trim()}`;
}
