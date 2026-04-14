import { Effect, Schema } from "effect";

import { TrimmedNonEmptyString } from "./baseSchemas";

export const UserInputQuestionOption = Schema.Struct({
  label: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
});
export type UserInputQuestionOption = typeof UserInputQuestionOption.Type;

export const UserInputQuestion = Schema.Struct({
  id: TrimmedNonEmptyString,
  header: TrimmedNonEmptyString,
  question: TrimmedNonEmptyString,
  options: Schema.Array(UserInputQuestionOption),
  multiSelect: Schema.optional(Schema.Boolean).pipe(
    Schema.withConstructorDefault(Effect.succeed(false)),
  ),
});
export type UserInputQuestion = typeof UserInputQuestion.Type;

export const ProviderUserInputAnswer = Schema.Union([
  TrimmedNonEmptyString,
  Schema.Array(TrimmedNonEmptyString),
]);
export type ProviderUserInputAnswer = typeof ProviderUserInputAnswer.Type;

export const ProviderUserInputAnswers = Schema.Record(Schema.String, ProviderUserInputAnswer);
export type ProviderUserInputAnswers = typeof ProviderUserInputAnswers.Type;
