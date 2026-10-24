import {
  type ProjectId,
  TerminalError,
  type TerminalOpenInput,
  type TerminalSessionSnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import {
  projectScriptRuntimeEnv,
  projectScriptTerminalInput,
} from "@t3tools/shared/projectScripts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProjectService from "../project/ProjectService.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";
import * as TerminalManager from "./Manager.ts";

export interface ThreadTerminalLaunchInput {
  readonly thread: {
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  };
  /** Relative paths resolve against the thread's workspace. */
  readonly cwd?: string;
  readonly env?: TerminalOpenInput["env"];
  /** Typed into the terminal after it opens. */
  readonly command?: string;
  readonly terminalId?: string;
}

export class ThreadTerminalProjectLookupError extends Schema.TaggedError<ThreadTerminalProjectLookupError>()(
  "ThreadTerminalProjectLookupError",
  { threadId: Schema.String, projectId: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to read project '${this.projectId}' for thread '${this.threadId}'.`;
  }
}

export class ThreadTerminalProjectNotFoundError extends Schema.TaggedError<ThreadTerminalProjectNotFoundError>()(
  "ThreadTerminalProjectNotFoundError",
  { threadId: Schema.String, projectId: Schema.String },
) {
  override get message(): string {
    return "The project was not found.";
  }
}

export class ThreadTerminalCwdOutsideWorkspaceError extends Schema.TaggedError<ThreadTerminalCwdOutsideWorkspaceError>()(
  "ThreadTerminalCwdOutsideWorkspaceError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return "cwd must be inside the project root or the thread's worktree.";
  }
}

export const ThreadTerminalLaunchError = Schema.Union([
  ThreadTerminalProjectLookupError,
  ThreadTerminalProjectNotFoundError,
  ThreadTerminalCwdOutsideWorkspaceError,
  TerminalError,
]);
export type ThreadTerminalLaunchError = typeof ThreadTerminalLaunchError.Type;

export class ThreadTerminalLauncher extends Context.Service<
  ThreadTerminalLauncher,
  {
    /**
     * Opens a terminal in the thread's drawer with the project script environment, confined to
     * the project root or the thread's worktree.
     */
    readonly open: (
      input: ThreadTerminalLaunchInput,
    ) => Effect.Effect<TerminalSessionSnapshot, ThreadTerminalLaunchError>;
  }
>()("t3/terminal/ThreadTerminalLauncher") {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const terminals = yield* TerminalManager.TerminalManager;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;

  const open = Effect.fn("ThreadTerminalLauncher.open")(function* (
    input: ThreadTerminalLaunchInput,
  ) {
    const { thread } = input;
    const project = yield* projects.getById(thread.projectId).pipe(
      Effect.mapError(
        (cause) =>
          new ThreadTerminalProjectLookupError({
            threadId: thread.id,
            projectId: thread.projectId,
            cause,
          }),
      ),
    );
    if (Option.isNone(project))
      return yield* new ThreadTerminalProjectNotFoundError({
        threadId: thread.id,
        projectId: thread.projectId,
      });
    const { workspaceRoot } = project.value;
    const roots = [workspaceRoot, thread.worktreePath]
      .filter((root) => root !== null)
      .map((root) => path.resolve(root));
    const cwd = path.resolve(thread.worktreePath ?? workspaceRoot, input.cwd ?? ".");
    if (!roots.some((root) => isWithinRoot(path, cwd, root)))
      return yield* new ThreadTerminalCwdOutsideWorkspaceError({ threadId: thread.id });
    const terminalId =
      input.terminalId ?? `agent-${(yield* crypto.randomUUIDv4().pipe(Effect.orDie)).slice(0, 8)}`;
    const session = yield* terminals.open({
      threadId: thread.id,
      terminalId,
      cwd,
      worktreePath: thread.worktreePath,
      env: {
        ...projectScriptRuntimeEnv({
          project: { cwd: workspaceRoot },
          worktreePath: thread.worktreePath,
        }),
        ...input.env,
      },
    });
    if (input.command !== undefined)
      yield* terminals.write({
        threadId: thread.id,
        terminalId,
        data: projectScriptTerminalInput(input.command),
      });
    return session;
  });

  return ThreadTerminalLauncher.of({ open });
});

export const layer = Layer.effect(ThreadTerminalLauncher, make);
