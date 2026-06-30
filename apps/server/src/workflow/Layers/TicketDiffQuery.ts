import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { parseTurnDiffFilesFromUnifiedDiff } from "../../checkpointing/Diffs.ts";
import { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import { WorkflowEventStoreError } from "../Services/Errors.ts";
import {
  TicketDiffQuery,
  WorktreeDiffPort,
  type TicketDiffQueryShape,
  type WorktreeDiffPortShape,
} from "../Services/TicketDiffQuery.ts";

const make = Effect.gen(function* () {
  const port = yield* WorktreeDiffPort;

  const getTicketDiff: TicketDiffQueryShape["getTicketDiff"] = (ticketId, cwd, baseRef) =>
    Effect.gen(function* () {
      const { patch, truncated } = yield* port.diffRefToWorktree({ cwd, baseRef });
      const files = parseTurnDiffFilesFromUnifiedDiff(patch);

      return {
        ticketId,
        baseRef,
        patch,
        files,
        truncated,
      };
    });

  return { getTicketDiff } satisfies TicketDiffQueryShape;
});

export const TicketDiffQueryLive = Layer.effect(TicketDiffQuery, make);

export const WorktreeDiffPortLive = Layer.effect(
  WorktreeDiffPort,
  Effect.gen(function* () {
    const git = yield* GitVcsDriver;

    const diffRefToWorktree: WorktreeDiffPortShape["diffRefToWorktree"] = ({ cwd, baseRef }) =>
      Effect.gen(function* () {
        const tracked = yield* git.execute({
          operation: "WorkflowTicketDiff.tracked",
          cwd,
          args: ["diff", "--patch", "--minimal", `${baseRef}^{commit}`, "--"],
          maxOutputBytes: 120_000,
          appendTruncationMarker: true,
        });
        const untrackedList = yield* git
          .execute({
            operation: "WorkflowTicketDiff.untracked.list",
            cwd,
            args: ["ls-files", "--others", "--exclude-standard", "-z"],
            maxOutputBytes: 120_000,
            appendTruncationMarker: true,
          })
          .pipe(
            Effect.orElseSucceed(() => ({
              stdout: "",
              stdoutTruncated: false,
            })),
          );
        const untrackedPaths = untrackedList.stdout.split("\0").filter((path) => path.length > 0);
        const untrackedDiffs = yield* Effect.forEach(
          untrackedPaths,
          (path) =>
            git.execute({
              operation: "WorkflowTicketDiff.untracked.diff",
              cwd,
              args: ["diff", "--no-index", "--patch", "--minimal", "--", "/dev/null", path],
              allowNonZeroExit: true,
              maxOutputBytes: 120_000,
              appendTruncationMarker: true,
            }),
          { concurrency: 4 },
        );

        return {
          patch: [
            tracked.stdout.trimEnd(),
            ...untrackedDiffs.map((result) => result.stdout.trimEnd()),
          ]
            .filter((part) => part.length > 0)
            .join("\n"),
          truncated:
            tracked.stdoutTruncated ||
            untrackedList.stdoutTruncated ||
            untrackedDiffs.some((result) => result.stdoutTruncated),
        };
      }).pipe(
        Effect.mapError(
          (cause) => new WorkflowEventStoreError({ message: "ticket diff failed", cause }),
        ),
      );

    return { diffRefToWorktree } satisfies WorktreeDiffPortShape;
  }),
);
