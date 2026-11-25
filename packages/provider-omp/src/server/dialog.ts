import type {
  OrchestrationV2UserInputQuestion,
  ProviderUserInputAnswers,
} from "@t3tools/contracts";
import { array, record, string } from "./rpc.ts";

export function readQuestions(frame: Record<string, unknown>, requestId: string) {
  const title = string(frame.title)?.trim() || "Oh My Pi";
  if (frame.method === "ask") {
    return array(frame.questions).map((value): OrchestrationV2UserInputQuestion | undefined => {
      const question = record(value);
      const id = string(question.id);
      const text = string(question.question)?.trim();
      if (!id?.trim() || !text) return undefined;
      return {
        id,
        header: string(question.header)?.trim() || title,
        question: text,
        multiSelect: question.multi === true,
        options: array(question.options).flatMap((option) => {
          const item = record(option);
          const label = string(item.label);
          if (!label?.trim()) return [];
          const preview = string(item.preview);
          return [
            {
              label: label.trim(),
              value: label,
              description: string(item.description)?.trim() || label.trim(),
              ...(preview === undefined ? {} : { preview }),
            },
          ];
        }),
      };
    });
  }
  const details = array(frame.optionDetails);
  const checked = new Set(array(frame.checkedIndices));
  const markableCount = typeof frame.markableCount === "number" ? frame.markableCount : Infinity;
  const options = array(frame.options).flatMap((value, index) => {
    if (typeof value !== "string" || !value.trim()) return [];
    const label = value.trim();
    const marker =
      frame.selectionMarker === "checkbox" && index < markableCount
        ? checked.has(index)
          ? "☑ "
          : "☐ "
        : "";
    return [
      {
        label: `${marker}${label}`,
        value,
        description: string(record(details[index]).description)?.trim() || label,
      },
    ];
  });
  return [
    {
      id: requestId,
      header: "Oh My Pi",
      question: title,
      options,
      allowCustomAnswer: frame.method !== "select",
      ...(frame.method === "editor" && typeof frame.prefill === "string"
        ? { initialAnswer: frame.prefill }
        : {}),
    },
  ] satisfies OrchestrationV2UserInputQuestion[];
}

export function dialogAnswer(
  method: string,
  questions: ReadonlyArray<OrchestrationV2UserInputQuestion>,
  answers: ProviderUserInputAnswers | undefined,
) {
  if (!answers) return undefined;
  if (method !== "ask") {
    const question = questions[0];
    const value = question === undefined ? undefined : answers[question.id];
    return typeof value === "string" &&
      (method !== "select" || question?.options.some((option) => option.value === value))
      ? { value }
      : undefined;
  }
  const result = [];
  for (const question of questions) {
    const value = answers[question.id];
    const candidates = typeof value === "string" ? [value] : array(value);
    const choices = question.options.map((option) => option.value);
    const selectedOptions = [
      ...new Set(
        candidates.filter(
          (entry): entry is string => typeof entry === "string" && choices.includes(entry),
        ),
      ),
    ];
    if (selectedOptions.length !== candidates.length && typeof value !== "string") return undefined;
    if (!question.multiSelect && selectedOptions.length > 1) return undefined;
    result.push({
      id: question.id,
      selectedOptions,
      ...(typeof value === "string" && selectedOptions.length === 0 ? { customInput: value } : {}),
    });
  }
  return { answers: result };
}
