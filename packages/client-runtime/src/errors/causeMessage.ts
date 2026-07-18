import * as Cause from "effect/Cause";

export function causeFailureMessage(cause: Cause.Cause<unknown>, fallback: string): string {
  const message = failureMessage(Cause.squash(cause));
  return message !== null && message.trim().length > 0 ? message : fallback;
}

export function failureMessage(error: unknown): string | null {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    return typeof error.message === "string" ? error.message : null;
  }
  return null;
}
