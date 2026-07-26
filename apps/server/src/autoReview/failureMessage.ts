import * as Cause from "effect/Cause";

const MAX_LENGTH = 400;

/**
 * Collapse a failed auto-review run into one line for the job store.
 *
 * The macOS settings tab renders `job.error` verbatim in a two-line label, so
 * `Cause.pretty` output (multi-line, stack-trace tail, Effect internals) shows
 * up as noise with the actual reason clipped off. Prefer the error's own
 * `detail`/`message`, which the source-control and text-generation errors
 * already write as human-readable sentences.
 */
export function describeAutoReviewFailure(cause: Cause.Cause<unknown>): string {
  const messages: Array<string> = [];
  for (const error of Cause.prettyErrors(cause)) {
    const described = describeError(error);
    if (described && !messages.includes(described)) {
      messages.push(described);
    }
  }
  if (messages.length === 0) {
    const squashed = describeError(Cause.squash(cause));
    if (squashed) {
      messages.push(squashed);
    }
  }
  const combined = messages.join(" — ") || "Auto-review failed for an unknown reason.";
  return combined.length > MAX_LENGTH ? `${combined.slice(0, MAX_LENGTH - 1)}…` : combined;
}

function describeError(error: unknown): string {
  if (typeof error === "string") {
    return firstLine(error);
  }
  if (typeof error !== "object" || error === null) {
    return "";
  }
  const detail = (error as { readonly detail?: unknown }).detail;
  const message = (error as { readonly message?: unknown }).message;
  const parts: Array<string> = [];
  if (typeof message === "string") {
    parts.push(firstLine(message));
  }
  // `detail` is the actionable half of the structured VCS/text-generation
  // errors; the message usually prefixes it with the operation name.
  if (typeof detail === "string") {
    const line = firstLine(detail);
    if (line && !parts.some((part) => part.includes(line))) {
      parts.push(line);
    }
  }
  return parts.filter(Boolean).join(": ");
}

function firstLine(value: string): string {
  return (
    value
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}
