import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { GitCommandError, VcsUnsupportedOperationError } from "@t3tools/contracts";
import { JjProcessExitError } from "../vcs/JjProcess.ts";

/** Read the typed refusal before Schema.Defect flattens nested errors on the wire. */
export const jjUnsupportedDetail = (cause: unknown): string | undefined => {
  const seen = new Set<object>();
  while (typeof cause === "object" && cause !== null && !seen.has(cause)) {
    if (Schema.is(VcsUnsupportedOperationError)(cause)) {
      return cause.detail;
    }
    seen.add(cause);
    cause = "cause" in cause ? cause.cause : undefined;
  }
  return undefined;
};

export const jjFailure = (operation: string, cwd: string, detail: string, cause?: unknown) => {
  const unsupportedDetail = jjUnsupportedDetail(cause);
  const reason = Schema.is(GitCommandError)(cause)
    ? cause.reason
    : Schema.is(JjProcessExitError)(cause)
      ? cause.reason
      : undefined;
  return new GitCommandError({
    operation,
    command: "jj",
    cwd,
    detail: unsupportedDetail ?? detail,
    ...(unsupportedDetail !== undefined
      ? { reason: "unsupported_repository" as const }
      : reason !== undefined
        ? { reason }
        : {}),
    ...(cause !== undefined ? { cause } : {}),
  });
};

export const mapJjFailure = (operation: string, cwd: string, detail: string) =>
  Effect.mapError((cause: unknown) => jjFailure(operation, cwd, detail, cause));
