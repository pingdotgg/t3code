import type { OrchestrationV2UserInputQuestion } from "@t3tools/contracts";
import { ompRecordField as field, ompRecordString as string } from "./rpc.ts";

export function ompAskQuestions(event: unknown): ReadonlyArray<OrchestrationV2UserInputQuestion> {
  const questions = field(event, "questions");
  if (!Array.isArray(questions)) return [];
  return questions.flatMap((question) => {
    const id = string(question, "id");
    const text = string(question, "question");
    if (!id || !text) return [];
    const options = field(question, "options");
    return [
      {
        id,
        header: string(question, "header") ?? "Question",
        question: text,
        multiSelect: field(question, "multi") === true,
        allowCustomAnswer: true,
        options: Array.isArray(options)
          ? options.flatMap((option) => {
              const label = string(option, "label");
              return label
                ? [{ label, value: label, description: string(option, "description") ?? label }]
                : [];
            })
          : [],
      },
    ];
  });
}

export function ompAskResponse(
  questions: ReadonlyArray<OrchestrationV2UserInputQuestion>,
  answers: Record<string, unknown> | undefined,
) {
  if (answers === undefined) return { cancelled: true };
  return {
    answers: questions.map((question) => {
      const answer = answers[question.id];
      const values = Array.isArray(answer)
        ? answer.filter((value): value is string => typeof value === "string")
        : typeof answer === "string"
          ? [answer]
          : [];
      const labels = new Set(question.options.map((option) => option.label));
      const selectedOptions = values.filter((value) => labels.has(value));
      const customInput = values.filter((value) => !labels.has(value)).join("\n");
      return { id: question.id, selectedOptions, ...(customInput ? { customInput } : {}) };
    }),
  };
}
