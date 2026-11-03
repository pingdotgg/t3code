import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "./ProjectService.ts";

/** The directory a thread works in, or undefined when the thread or its project is gone. */
export const threadWorkspaceRoot = Effect.fn("threadWorkspaceRoot")(
  function* (threadId: ThreadId) {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const projects = yield* ProjectService.ProjectService;
    const shell = yield* threads.getThreadShell(threadId);
    if (shell === null) return undefined;
    if (shell.worktreePath) return shell.worktreePath;
    return Option.getOrUndefined(yield* projects.getById(shell.projectId))?.workspaceRoot;
  },
  Effect.orElseSucceed(() => undefined),
);
