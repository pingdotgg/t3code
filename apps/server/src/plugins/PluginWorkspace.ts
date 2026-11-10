import {
  ProjectId,
  type ProjectListEntriesResult,
  type ProjectReadFileResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

export class PluginWorkspaceThreadNotFoundError extends Schema.TaggedError<PluginWorkspaceThreadNotFoundError>()(
  "PluginWorkspaceThreadNotFoundError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class PluginWorkspaceProjectNotFoundError extends Schema.TaggedError<PluginWorkspaceProjectNotFoundError>()(
  "PluginWorkspaceProjectNotFoundError",
  { threadId: ThreadId, projectId: ProjectId },
) {
  override get message(): string {
    return `The project of thread ${this.threadId} was not found.`;
  }
}

type ResolveError =
  | PluginWorkspaceThreadNotFoundError
  | PluginWorkspaceProjectNotFoundError
  | ProjectionStore.ProjectionStoreV2Error
  | ProjectStore.ProjectStoreV2Error;

/** Read-only access to the folder a thread works in, for trusted server plugins. */
export class PluginWorkspace extends Context.Service<
  PluginWorkspace,
  {
    /** The immediate children of `directoryPath`, the workspace root when omitted. */
    readonly listEntries: (input: {
      readonly threadId: ThreadId;
      readonly directoryPath?: string | undefined;
    }) => Effect.Effect<
      ProjectListEntriesResult,
      ResolveError | WorkspaceEntries.WorkspaceEntriesError
    >;
    readonly readFile: (input: {
      readonly threadId: ThreadId;
      readonly relativePath: string;
    }) => Effect.Effect<
      ProjectReadFileResult,
      | ResolveError
      | WorkspaceFileSystem.WorkspaceFileSystemError
      | WorkspacePaths.WorkspacePathOutsideRootError
    >;
  }
>()("t3/plugins/PluginWorkspace") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;

  const resolveCwd = Effect.fn("PluginWorkspace.resolveCwd")(function* (threadId: ThreadId) {
    const thread = yield* projections.getThread(threadId).pipe(
      Effect.catchTags({
        ProjectionStoreThreadNotFoundError: () =>
          Effect.fail(new PluginWorkspaceThreadNotFoundError({ threadId })),
      }),
    );
    if (thread.deletedAt !== null) {
      return yield* new PluginWorkspaceThreadNotFoundError({ threadId });
    }
    // A deleted project's worktrees are no longer the user's workspace, even where they remain.
    const project = yield* projects.get(thread.projectId);
    if (Option.isNone(project)) {
      return yield* new PluginWorkspaceProjectNotFoundError({
        threadId,
        projectId: thread.projectId,
      });
    }
    return thread.worktreePath ?? project.value.workspaceRoot;
  });

  const listEntries: PluginWorkspace["Service"]["listEntries"] = Effect.fn(
    "PluginWorkspace.listEntries",
  )(function* (input) {
    const cwd = yield* resolveCwd(input.threadId);
    // An undefined directory lists the whole tree from the search index.
    return yield* workspaceEntries.list({ cwd, directoryPath: input.directoryPath ?? "" });
  });

  const readFile: PluginWorkspace["Service"]["readFile"] = Effect.fn("PluginWorkspace.readFile")(
    function* (input) {
      const cwd = yield* resolveCwd(input.threadId);
      // `WorkspaceFileSystem.readFile` reads absolute and `~/` paths from anywhere on the host, so
      // only a path confined to the root reaches it, marked `./` so a `~` folder stays relative.
      const target = yield* workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: cwd,
        relativePath: input.relativePath,
      });
      return yield* workspaceFileSystem.readFile({ cwd, relativePath: `./${target.relativePath}` });
    },
  );

  return PluginWorkspace.of({ listEntries, readFile });
});

export const layer = Layer.effect(PluginWorkspace, make);
