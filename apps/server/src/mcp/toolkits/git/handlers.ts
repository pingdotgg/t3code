import { OrchestratorMcpFailure, type ProjectId, type ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as GitWorkflow from "../../../git/GitWorkflowService.ts";
import { linkCreatedPullRequest } from "../../../git/linkCreatedPullRequest.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as PullRequests from "../../../pullRequest/PullRequestService.ts";
import * as VcsStatus from "../../../vcs/VcsStatusBroadcaster.ts";
import {
  newCommandId,
  readFullAccessCaller,
  readThread,
  readWritableThread,
  unavailable,
} from "../../threadAccess.ts";
import { GitToolkit, MAX_STATUS_FILES } from "./tools.ts";

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/** Git's own words help an agent recover (a dirty tree, an existing branch); keep them short. */
const gitFailure = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: error.message.slice(0, 2000),
  });

/** The thread's checkout, resolved as t3_thread_diff does. */
const checkoutOf = Effect.fn("mcp.git.checkoutOf")(function* (thread: {
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
}) {
  const projects = yield* Project.ProjectService;
  const project = yield* projects.getById(thread.projectId).pipe(Effect.mapError(unavailable));
  if (Option.isNone(project)) return yield* invalid("The project was not found.");
  return thread.worktreePath ?? project.value.workspaceRoot;
});

export const GitToolkitHandlersLive = GitToolkit.toLayer({
  t3_git_status: (input) =>
    Effect.gen(function* () {
      // A cold status cache fetches, which runs git and its credential helpers on the host.
      yield* readFullAccessCaller("Git status requires a live full-access/default caller.");
      const {
        projection: { thread },
      } = yield* readThread(input.threadId);
      const cwd = yield* checkoutOf(thread);
      const vcs = yield* VcsStatus.VcsStatusBroadcaster;
      // Local status is cheap and changes under the agent; remote counts come from the cache,
      // which fetches once per checkout like the branch toolbar.
      yield* vcs.refreshLocalStatus(cwd).pipe(Effect.mapError(unavailable));
      const status = yield* vcs.getStatus({ cwd }).pipe(Effect.mapError(unavailable));
      return {
        threadId: thread.id,
        cwd,
        isRepo: status.isRepo,
        branch: status.refName,
        isDefaultBranch: status.isDefaultRef,
        hasPrimaryRemote: status.hasPrimaryRemote,
        hasUpstream: status.hasUpstream,
        aheadCount: status.aheadCount,
        behindCount: status.behindCount,
        hasWorkingTreeChanges: status.hasWorkingTreeChanges,
        insertions: status.workingTree.insertions,
        deletions: status.workingTree.deletions,
        files: status.workingTree.files.slice(0, MAX_STATUS_FILES),
        filesTruncated: status.workingTree.files.length > MAX_STATUS_FILES,
        pullRequest: status.pr,
      };
    }),
  t3_git: (input) =>
    Effect.gen(function* () {
      yield* readFullAccessCaller("Git actions require a live full-access/default caller.");
      const {
        threads,
        projection: { thread },
      } = yield* readWritableThread(input.threadId);
      const cwd = yield* checkoutOf(thread);
      const git = yield* GitWorkflow.GitWorkflowService;
      const vcs = yield* VcsStatus.VcsStatusBroadcaster;
      // The branch toolbar records a new checkout on the thread; do the same so its label is current.
      const recordBranch = (threadId: ThreadId, branch: string) =>
        newCommandId().pipe(
          Effect.flatMap((commandId) =>
            threads.dispatch({ type: "thread.metadata.update", commandId, threadId, branch }),
          ),
          Effect.ignore({ log: true }),
        );
      const done = <A>(result: A) =>
        vcs
          .refreshStatus(cwd)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.as(result));
      const empty = {
        threadId: thread.id,
        action: input.action,
        branch: null,
        pull: null,
        steps: null,
      };

      switch (input.action) {
        case "create_branch":
        case "switch_branch": {
          if (input.branch === undefined) return yield* invalid(`Pass branch for ${input.action}.`);
          const branch =
            input.action === "create_branch"
              ? (yield* git
                  .createRef({ cwd, refName: input.branch, switchRef: true })
                  .pipe(Effect.mapError(gitFailure))).refName
              : ((yield* git
                  .switchRef({ cwd, refName: input.branch })
                  .pipe(Effect.mapError(gitFailure))).refName ?? input.branch);
          yield* recordBranch(thread.id, branch);
          return yield* done({ ...empty, branch });
        }
        case "pull": {
          const pull = yield* git.pullCurrentBranch(cwd).pipe(Effect.mapError(gitFailure));
          return yield* done({ ...empty, pull });
        }
        default: {
          const crypto = yield* Crypto.Crypto;
          const actionId = `mcp:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`;
          const result = yield* git
            .runStackedAction({
              actionId,
              cwd,
              action: input.action,
              threadId: thread.id,
              projectId: thread.projectId,
              ...(input.commitMessage === undefined ? {} : { commitMessage: input.commitMessage }),
              ...(input.featureBranch === undefined ? {} : { featureBranch: input.featureBranch }),
              ...(input.filePaths === undefined ? {} : { filePaths: input.filePaths }),
            })
            .pipe(Effect.mapError(gitFailure));
          // The same follow-ups ws.ts runs after git.runStackedAction.
          yield* linkCreatedPullRequest({
            threadId: thread.id,
            result,
            commandId: Effect.succeed(yield* newCommandId()),
          });
          if (result.push.status === "pushed")
            yield* (yield* PullRequests.PullRequestService).refreshAfterTurn(thread.projectId);
          const branch = result.branch.status === "created" ? (result.branch.name ?? null) : null;
          if (branch !== null) yield* recordBranch(thread.id, branch);
          const steps = {
            branch: result.branch,
            commit: result.commit,
            push: result.push,
            pr: result.pr,
          };
          return yield* done({ ...empty, branch, steps });
        }
      }
    }),
});
