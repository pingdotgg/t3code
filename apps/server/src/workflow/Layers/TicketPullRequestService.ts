import type { StepOutcome } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { applyInstructionTemplate, type TicketTemplateVars } from "../instructionTemplate.ts";
import { GitHubPort } from "../Services/GitHubPort.ts";
import { MergeGitPort } from "../Services/TicketMergeService.ts";
import {
  TicketPullRequestService,
  type TicketPullRequestInput,
  type TicketPullRequestServiceShape,
} from "../Services/TicketPullRequestService.ts";
import { WorkflowEventCommitter } from "../Services/WorkflowEventCommitter.ts";
import type { WorkflowEventInput } from "../Services/WorkflowEventStore.ts";
import { WorkflowIds } from "../Services/WorkflowIds.ts";
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";
import { cleanupTicketScratch } from "./ticketScratchCleanup.ts";

const blocked = (reason: string): StepOutcome => ({ _tag: "blocked", reason });

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const make = Effect.gen(function* () {
  const github = yield* GitHubPort;
  const git = yield* MergeGitPort;
  const read = yield* WorkflowReadModel;
  const committer = yield* WorkflowEventCommitter;
  const ids = yield* WorkflowIds;

  const open: TicketPullRequestServiceShape["open"] = (input) =>
    Effect.gen(function* () {
      // 1. Preflight: a missing/unauthenticated gh is human-fixable, so block
      // (nothing has been pushed) rather than fail.
      const preflight = yield* github.preflight(input.worktreePath);
      if (!preflight.ok) {
        return blocked(preflight.reason);
      }

      // Resolve the base branch BEFORE building the template vars: when the
      // step omits `base`, it falls back to the repo default branch, and
      // `{{ticket.baseRef}}` must render that resolved branch — not "" — in the
      // snapshot message and PR title/body below. (PR #3032 macroscope review.)
      const base = input.step.base ?? (yield* github.defaultBranch(input.worktreePath));

      // Ticket detail backs the template vars and the snapshot-commit message.
      const detail = yield* read.getTicketDetail(input.ticketId);
      const ticketTitle = detail?.ticket.title ?? "workflow ticket";
      const vars: TicketTemplateVars = {
        title: ticketTitle,
        description: detail?.ticket.description ?? "",
        id: input.ticketId as string,
        baseRef: base,
        discussion: "",
      };

      // 2. Snapshot any uncommitted agent work onto the ticket branch so the
      // PR carries the full accumulated state (mirrors TicketMergeService).
      const snapshotMessage =
        input.step.titleTemplate !== undefined
          ? applyInstructionTemplate(input.step.titleTemplate, vars)
          : `${ticketTitle} (${input.ticketId})`;
      // Purge the per-ticket scratch tree (`.t3/ticket/<id>`) BEFORE the status
      // read, so the status reflects post-cleanup reality and the `git add -A`
      // snapshot never stages pipeline scratch (DESCRIPTION.md, handoff/, design/)
      // into the PR. (TicketMergeService already does this before its snapshot.)
      yield* cleanupTicketScratch(git, input.worktreePath, input.ticketId as string);
      const worktreeStatus = yield* git.run({
        cwd: input.worktreePath,
        args: ["status", "--porcelain"],
      });
      if (worktreeStatus.stdout.trim().length > 0) {
        yield* git.run({ cwd: input.worktreePath, args: ["add", "-A"] });
        yield* git.run({
          cwd: input.worktreePath,
          args: ["commit", "--no-verify", "-m", snapshotMessage],
        });
      }

      // 3. Render the PR title and body, always appending the ticket trailer.
      const title =
        input.step.titleTemplate !== undefined
          ? applyInstructionTemplate(input.step.titleTemplate, vars)
          : ticketTitle;
      const renderedBody =
        input.step.bodyTemplate !== undefined
          ? applyInstructionTemplate(input.step.bodyTemplate, vars)
          : "";
      const body = `${renderedBody}${renderedBody ? "\n\n" : ""}t3-ticket: ${input.ticketId}`;

      // 5. Push + open (or adopt) the PR. A diverged remote is human-fixable;
      // map it to blocked. Other failures are real infra faults — let them
      // propagate on the error channel.
      const result = yield* github
        .openPr({
          cwd: input.worktreePath,
          branch: input.worktreeRef,
          base,
          title,
          body,
          draft: input.step.draft ?? false,
        })
        .pipe(
          Effect.catchIf(
            (error) => error.message.startsWith("branch diverged"),
            (error) => Effect.succeed({ _blocked: error.message } as const),
          ),
        );
      if ("_blocked" in result) {
        return blocked(result._blocked);
      }

      // 6. Resolve the remote for the TicketPrOpened projection. Done only
      // after the push guard so a resolveRemote fault can't pre-empt a block.
      const remote = yield* github.resolveRemote(input.worktreePath);

      // 7. Emit TicketPrOpened. The projection upsert is idempotent, so this is
      // safe whether the PR was freshly created or adopted.
      const eventId = yield* ids.eventId();
      yield* committer.commit({
        type: "TicketPrOpened",
        eventId,
        ticketId: input.ticketId,
        occurredAt: yield* nowIso,
        payload: {
          stepRunId: input.stepRunId,
          prNumber: result.number,
          url: result.url,
          branch: input.worktreeRef,
          remoteName: remote.remoteName,
          repo: remote.repo,
        },
      } as WorkflowEventInput);

      // 8. Completed.
      return {
        _tag: "completed",
        output: { prNumber: result.number, url: result.url },
      };
    });

  const land: TicketPullRequestServiceShape["land"] = (input) =>
    Effect.gen(function* () {
      // 1. The PR to land is whichever one `open` recorded for this ticket. No
      // recorded state means there is nothing to merge — block (human-fixable)
      // rather than fail.
      const state = yield* read.getTicketPrState(input.ticketId);
      if (state === null) {
        return blocked("no PR to land");
      }

      // 2. Merge through gh. Branch cleanup (deleteBranch) is best-effort inside
      // the port; a not-mergeable PR (branch protection, failing checks, review
      // required) is human-fixable, so map it to blocked. Real infra faults
      // propagate on the error channel.
      const result = yield* github.mergePr({
        cwd: input.worktreePath,
        prNumber: state.prNumber,
        strategy: input.step.strategy ?? "squash",
        deleteBranch: input.step.deleteBranch ?? true,
        branch: state.branch,
        remoteName: state.remoteName,
      });
      if (!result.ok) {
        return blocked(result.reason);
      }
      return { _tag: "completed" };
    });

  return { open, land } satisfies TicketPullRequestServiceShape;
});

export const TicketPullRequestServiceLive = Layer.effect(TicketPullRequestService, make);
