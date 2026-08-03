/**
 * fork: f4 — conflict resolution and operation abort.
 *
 * **Detect and surface, do not automate.** `resolveConflict` and
 * `abortOperation` are here; `rebase --continue` deliberately is not. Driving
 * an interactive sequencer through a non-interactive subprocess is a reliable
 * source of stuck states, and t3 already has a terminal inline — the panel
 * tells the user to run it there.
 */
import * as Effect from "effect/Effect";

import type { WorkingCopyConflictSide, WorkingCopyOperation } from "@t3tools/contracts";
import * as commands from "./commands.ts";
import type { WorkingCopyGit } from "./WorkingCopyGit.ts";

export const resolveConflict = Effect.fn("workingCopy.resolveConflict")(function* (
  git: WorkingCopyGit,
  input: {
    readonly path: string;
    /** Omitted means "mark resolved as-is" — the user edited the file by hand. */
    readonly side?: WorkingCopyConflictSide | undefined;
  },
) {
  if (input.side !== undefined) {
    yield* git.ok({
      operation: "workingCopy.resolveConflict",
      args: commands.checkoutConflictSideArgs(input.side, input.path),
      mutating: true,
    });
  }
  yield* git.ok({
    operation: "workingCopy.resolveConflict",
    args: commands.markResolvedArgs(input.path),
    mutating: true,
  });
});

export const abortOperation = Effect.fn("workingCopy.abortOperation")(function* (
  git: WorkingCopyGit,
  operation: WorkingCopyOperation,
) {
  yield* git.ok({
    operation: "workingCopy.abortOperation",
    args: commands.abortOperationArgs(operation),
    mutating: true,
  });
});
