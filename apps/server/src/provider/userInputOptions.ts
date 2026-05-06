import type { UserInputQuestionOption } from "@t3tools/contracts";

export function withCustomUserInputOption(
  options: ReadonlyArray<UserInputQuestionOption>,
): ReadonlyArray<UserInputQuestionOption> {
  return options.filter((option) => option.label.trim().toLowerCase() !== "other");
}
