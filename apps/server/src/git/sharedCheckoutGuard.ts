import {
  GitCommandError,
  type OrchestrationV2ThreadShell,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

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
  const projectService = yield* ProjectService.ProjectService;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const project = yield* projectService.getByWorkspaceRoot(cwd).pipe(
    Effect.map(Option.getOrNull),
    Effect.orElseSucceed(() => null),
  );
  const snapshots = yield* Effect.all(
    [
      threadManagement.getShellSnapshot({ location: "active", worktreePath: cwd }),
      ...(project === null
        ? []
        : [threadManagement.getShellSnapshot({ location: "active", projectId: project.id })]),
    ],
    { concurrency: "unbounded" },
  ).pipe(Effect.orElseSucceed(() => []));
  const busy = busyThreadsInCheckout({
    cwd,
    projectId: project?.id ?? null,
    threads: [
      ...new Map(
        snapshots.flatMap((snapshot) => snapshot.threads).map((thread) => [thread.id, thread]),
      ).values(),
    ],
  });
  if (busy.length === 0) return;
  return yield* new GitCommandError({
    operation,
    command: "git checkout",
    cwd,
    detail: describeBusyCheckout(busy.map((thread) => thread.title)),
  });
});
