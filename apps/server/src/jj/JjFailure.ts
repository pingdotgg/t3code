import * as Effect from "effect/Effect";

import { GitCommandError } from "@t3tools/contracts";

export const jjFailure = (operation: string, cwd: string, detail: string, cause?: unknown) =>
  new GitCommandError({
    operation,
    command: "jj",
    cwd,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });

export const mapJjFailure = (operation: string, cwd: string, detail: string) =>
  Effect.mapError((cause: unknown) => jjFailure(operation, cwd, detail, cause));
