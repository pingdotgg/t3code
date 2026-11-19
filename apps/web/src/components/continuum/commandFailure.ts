import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

/** The message a failed environment command carries, or `fallback` when it has none. */
export function commandFailureText(
  result: AtomCommandResult<unknown, unknown>,
  fallback: string,
): string | null {
  if (result._tag === "Success") return null;
  const error = squashAtomCommandFailure(result);
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}
