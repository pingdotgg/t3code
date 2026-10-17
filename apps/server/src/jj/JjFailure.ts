import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { GitCommandError } from "@t3tools/contracts";
import { JjProcessExitError } from "../vcs/JjProcess.ts";

export const jjFailure = (operation: string, cwd: string, detail: string, cause?: unknown) => {
  const reason = Schema.is(GitCommandError)(cause)
    ? cause.reason
    : Schema.is(JjProcessExitError)(cause)
      ? cause.reason
      : undefined;
  return new GitCommandError({
    operation,
    command: "jj",
    cwd,
    detail,
    ...(reason !== undefined ? { reason } : {}),
    ...(cause !== undefined ? { cause } : {}),
  });
};

export const mapJjFailure = (operation: string, cwd: string, detail: string) =>
  Effect.mapError((cause: unknown) => jjFailure(operation, cwd, detail, cause));
