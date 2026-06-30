import * as Effect from "effect/Effect";

import { ticketScratchDir } from "../instructionTemplate.ts";
import type { MergeGitPortShape } from "../Services/TicketMergeService.ts";

/** Unconditionally purge the whole per-ticket scratch tree (.t3/ticket/<id>):
 *  DESCRIPTION.md, handoff/, design/ — all pipeline scratch, never deliverables.
 *  The `-x` on git clean is deliberate: `.t3` is gitignored in many repos, so
 *  without it the scratch files are untracked-AND-ignored and would survive the
 *  purge on disk (lingering as stale artifacts). The pathspec scopes `-x` to the
 *  validated per-ticket dir, so nothing outside the scratch tree is touched. */
export const cleanupTicketScratch = (
  git: Pick<MergeGitPortShape, "run">,
  worktreePath: string,
  ticketId: string,
) =>
  Effect.gen(function* () {
    const dir = ticketScratchDir(ticketId); // validates the id
    yield* git
      .run({
        cwd: worktreePath,
        args: ["rm", "-r", "-f", "--ignore-unmatch", "--", dir],
        allowNonZeroExit: true,
      })
      .pipe(Effect.ignore);
    yield* git
      .run({
        cwd: worktreePath,
        args: ["clean", "-f", "-d", "-x", "--", dir],
        allowNonZeroExit: true,
      })
      .pipe(Effect.ignore);
  });
