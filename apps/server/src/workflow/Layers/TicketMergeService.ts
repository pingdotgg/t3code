import type { StepOutcome } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import { WorkflowEventStoreError } from "../Services/Errors.ts";
import {
  MergeGitPort,
  TicketMergeService,
  type MergeGitPortShape,
  type TicketMergeServiceShape,
} from "../Services/TicketMergeService.ts";
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";
import { cleanupTicketScratch } from "./ticketScratchCleanup.ts";

const blocked = (reason: string): StepOutcome => ({ _tag: "blocked", reason });
const completed: StepOutcome = { _tag: "completed" };

const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";

// Only the path-safe ticket id is templated into cleanup paths — titles and
// other free text could smuggle path segments into a git rm.
const resolveCleanupPath = (path: string, ticketId: string): string =>
  path.replace(/\{\{\s*ticket\.id\s*\}\}/g, ticketId);

const conflictSummary = (output: string) => {
  const lines = output
    .split("\n")
    .filter((line) => line.includes("CONFLICT"))
    .slice(0, 5);
  return lines.join("; ");
};

const make = Effect.gen(function* () {
  const git = yield* MergeGitPort;
  const read = yield* WorkflowReadModel;

  const merge: TicketMergeServiceShape["merge"] = (input) =>
    Effect.gen(function* () {
      const detail = yield* read.getTicketDetail(input.ticketId);
      const rawMessage = input.step.commitMessage?.trim();
      const message =
        rawMessage !== undefined && rawMessage.length > 0
          ? rawMessage
          : `${detail?.ticket.title ?? "workflow ticket"} (${input.ticketId})`;

      // The per-ticket scratch tree (`.t3/ticket/<id>`: DESCRIPTION.md, handoff/,
      // design/) is pipeline scratch written by the executor — never a deliverable.
      // Purge it UNCONDITIONALLY — independent of `step.cleanupPaths` — so it never
      // reaches the snapshot commit, the merged branch, or the PR diff.
      yield* cleanupTicketScratch(git, input.worktreePath, input.ticketId as string);

      // Working files like PLAN.md / REVIEW.md are pipeline scratch space —
      // drop them before the snapshot so they never land in the target branch.
      for (const rawCleanupPath of input.step.cleanupPaths ?? []) {
        const cleanupPath = resolveCleanupPath(rawCleanupPath as string, input.ticketId as string);
        // rm covers tracked files, clean covers untracked ones (-d so a
        // per-ticket scratch directory disappears with its files).
        yield* git
          .run({
            cwd: input.worktreePath,
            args: ["rm", "-r", "-f", "--ignore-unmatch", "--", cleanupPath],
            allowNonZeroExit: true,
          })
          .pipe(Effect.ignore);
        yield* git
          .run({
            cwd: input.worktreePath,
            args: ["clean", "-f", "-d", "--", cleanupPath],
            allowNonZeroExit: true,
          })
          .pipe(Effect.ignore);
      }

      // Snapshot any uncommitted agent work onto the ticket branch so the
      // merge carries the full accumulated state, not just prior commits.
      const worktreeStatus = yield* git.run({
        cwd: input.worktreePath,
        args: ["status", "--porcelain"],
      });
      if (worktreeStatus.stdout.trim().length > 0) {
        yield* git.run({ cwd: input.worktreePath, args: ["add", "-A"] });
        yield* git.run({
          cwd: input.worktreePath,
          args: ["commit", "--no-verify", "-m", message],
        });
      }

      // Preconditions on the repo checkout. Anything a human can fix by
      // tidying the repo is blocked (not failed) and never mutates state:
      // we refuse to touch a dirty tree and never switch the user's branch.
      const repoStatus = yield* git.run({
        cwd: input.repoRoot,
        args: ["status", "--porcelain"],
      });
      if (repoStatus.stdout.trim().length > 0) {
        return blocked(
          "Repo working tree has uncommitted changes; commit or stash them, then re-run the lane.",
        );
      }

      const branch = (yield* git.run({
        cwd: input.repoRoot,
        args: ["rev-parse", "--abbrev-ref", "HEAD"],
      })).stdout.trim();
      if (branch === "HEAD") {
        return blocked("Repo is on a detached HEAD; check out a branch first.");
      }
      if (input.step.target !== undefined && branch !== input.step.target) {
        return blocked(
          `Repo has "${branch}" checked out but this step merges into "${input.step.target}".`,
        );
      }

      const ahead = (yield* git.run({
        cwd: input.repoRoot,
        args: ["rev-list", "--count", `HEAD..${input.worktreeRef}`],
      })).stdout.trim();
      if (ahead === "0") {
        return completed;
      }

      const result = yield* git.run({
        cwd: input.repoRoot,
        args: ["merge", "--no-ff", "--no-verify", "-m", message, input.worktreeRef],
        allowNonZeroExit: true,
      });
      if (result.exitCode !== 0) {
        yield* git
          .run({ cwd: input.repoRoot, args: ["merge", "--abort"], allowNonZeroExit: true })
          .pipe(Effect.ignore);
        const conflicts = conflictSummary(`${result.stdout}\n${result.stderr}`);
        return blocked(
          conflicts.length > 0
            ? `Merge conflict: ${conflicts}`
            : `Merge failed: ${firstLine(result.stderr) || firstLine(result.stdout) || "unknown git error"}`,
        );
      }

      return completed;
    });

  return { merge } satisfies TicketMergeServiceShape;
});

export const TicketMergeServiceLive = Layer.effect(TicketMergeService, make);

export const MergeGitPortLive = Layer.effect(
  MergeGitPort,
  Effect.gen(function* () {
    const git = yield* GitVcsDriver;

    const run: MergeGitPortShape["run"] = (input) =>
      git
        .execute({
          operation: "WorkflowTicketMerge",
          cwd: input.cwd,
          args: [...input.args],
          ...(input.allowNonZeroExit === undefined
            ? {}
            : { allowNonZeroExit: input.allowNonZeroExit }),
        })
        .pipe(
          Effect.map((result) => ({
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          })),
          Effect.mapError(
            (cause) =>
              new WorkflowEventStoreError({ message: "workflow merge git command failed", cause }),
          ),
        );

    return { run } satisfies MergeGitPortShape;
  }),
);
