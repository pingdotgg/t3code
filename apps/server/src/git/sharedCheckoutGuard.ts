import {
  GitCommandError,
  type OrchestrationV2ThreadShell,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";

type CheckoutThread = Pick<
  OrchestrationV2ThreadShell,
  "id" | "title" | "projectId" | "worktreePath" | "activityRunStatus"
>;

/** Threads with an active run whose working directory is `cwd`. */
export function busyThreadsInCheckout<T extends CheckoutThread>(input: {
  readonly cwd: string;
  readonly projectId: ProjectId | null;
  readonly threads: ReadonlyArray<T>;
}): ReadonlyArray<T> {
  return input.threads.filter(
    (thread) =>
      (thread.activityRunStatus ?? null) !== null &&
      (thread.worktreePath === input.cwd ||
        (thread.worktreePath === null &&
          input.projectId !== null &&
          thread.projectId === input.projectId)),
  );
}

function describeBusyCheckout(titles: ReadonlyArray<string>): string {
  const quoted = titles.map((title) => `'${title}'`);
  const names =
    quoted.length <= 2
      ? quoted.join(" and ")
      : `${quoted.slice(0, 2).join(", ")} and ${quoted.length - 2} more`;
  return `${names} ${quoted.length === 1 ? "is" : "are"} still working in this checkout. Wait for ${quoted.length === 1 ? "it" : "them"} to finish, or use a worktree for a separate branch.`;
}

/** Switching a shared checkout's ref moves every thread working in it, mid-turn included. */
export const assertCheckoutIdle = Effect.fn("sharedCheckoutGuard.assertCheckoutIdle")(function* (
  operation: string,
  cwd: string,
) {
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const projectService = yield* ProjectService.ProjectService;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  // `git checkout` from a subdirectory moves the whole checkout; records may hold either spelling.
  const root = yield* gitWorkflow.repositoryRoot(cwd).pipe(Effect.orElseSucceed(() => null));
  const checkoutPaths = [...new Set([cwd, ...(root === null ? [] : [root])])];
  const busy = yield* Effect.forEach(
    checkoutPaths,
    (checkoutPath) =>
      Effect.gen(function* () {
        const project = yield* projectService.getByWorkspaceRoot(checkoutPath).pipe(
          Effect.map(Option.getOrNull),
          Effect.orElseSucceed(() => null),
        );
        // Each lookup fails open on its own, so one failure keeps what the other found.
        const snapshots = yield* Effect.forEach(
          [
            threadManagement.getShellSnapshot({ location: "active", worktreePath: checkoutPath }),
            ...(project === null
              ? []
              : [threadManagement.getShellSnapshot({ location: "active", projectId: project.id })]),
          ],
          (snapshot) => snapshot.pipe(Effect.orElseSucceed(() => ({ threads: [] }))),
          { concurrency: "unbounded" },
        );
        return busyThreadsInCheckout({
          cwd: checkoutPath,
          projectId: project?.id ?? null,
          threads: snapshots.flatMap((snapshot) => snapshot.threads),
        });
      }),
    { concurrency: "unbounded" },
  );
  const titles = [...new Map(busy.flat().map((thread) => [thread.id, thread.title])).values()];
  if (titles.length === 0) return;
  return yield* new GitCommandError({
    operation,
    command: "git checkout",
    cwd,
    detail: describeBusyCheckout(titles),
  });
});
