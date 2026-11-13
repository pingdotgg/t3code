import * as Cause from "effect/Cause";

export function failureMessage(cause: Cause.Cause<unknown>, fallback: string) {
  const failure = Cause.squash(cause);
  return failure instanceof Error && failure.message.trim().length > 0 ? failure.message : fallback;
}
