import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

export class DesktopWorkspaceError extends Data.TaggedError("DesktopWorkspaceError")<{
  readonly cause: PlatformError.PlatformError;
}> {
  override get message() {
    return `Failed to ensure student workspace: ${this.cause.message}`;
  }
}

export interface DesktopWorkspaceShape {
  readonly ensureStudentWorkspace: (input: {
    readonly slug: string;
    readonly agentsMarkdown?: string;
  }) => Effect.Effect<{ readonly folderPath: string }, DesktopWorkspaceError>;
}

export class DesktopWorkspace extends Context.Service<
  DesktopWorkspace,
  DesktopWorkspaceShape
>()("@t3tools/desktop/workspace/DesktopWorkspace") {}

const ensureStudentWorkspaceImpl = Effect.fnUntraced(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly workspaceRoot: string;
  readonly slug: string;
  readonly agentsMarkdown?: string;
}): Effect.fn.Return<{ readonly folderPath: string }, PlatformError.PlatformError> {
  const studentsDir = input.path.join(input.workspaceRoot, "students");
  const folderPath = input.path.join(studentsDir, input.slug);
  const agentsMarkdownPath = input.path.join(folderPath, "AGENTS.md");

  // Create the student workspace folder (idempotent)
  yield* input.fileSystem.makeDirectory(folderPath, { recursive: true });

  // Seed AGENTS.md only if it doesn't exist (idempotent)
  const agentsMarkdownExists = yield* input.fileSystem
    .exists(agentsMarkdownPath)
    .pipe(Effect.orElseSucceed(() => false));

  if (!agentsMarkdownExists && input.agentsMarkdown !== undefined) {
    yield* input.fileSystem.writeFileString(agentsMarkdownPath, input.agentsMarkdown);
  }

  return { folderPath };
});

export const layer = Layer.effect(
  DesktopWorkspace,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    // Workspace root is <baseDir>/workspace (e.g., ~/.t3/workspace or ~/.t3/dev/workspace)
    const workspaceRoot = path.join(environment.baseDir, "workspace");

    return DesktopWorkspace.of({
      ensureStudentWorkspace: (input) =>
        ensureStudentWorkspaceImpl({
          fileSystem,
          path,
          workspaceRoot,
          slug: input.slug,
          ...(input.agentsMarkdown !== undefined && { agentsMarkdown: input.agentsMarkdown }),
        }).pipe(
          Effect.mapError((cause) => new DesktopWorkspaceError({ cause })),
          Effect.withSpan("desktop.workspace.ensureStudentWorkspace"),
        ),
    });
  }),
);

export const layerTest = (workspaceRoot = "/tmp/test-workspace") =>
  Layer.effect(
    DesktopWorkspace,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspacesRef = yield* Ref.make(new Map<string, string>());

      return DesktopWorkspace.of({
        ensureStudentWorkspace: (input) =>
          Effect.gen(function* () {
            const studentsDir = path.join(workspaceRoot, "students");
            const folderPath = path.join(studentsDir, input.slug);

            // Store in ref for test assertions
            yield* Ref.update(workspacesRef, (map) => {
              const newMap = new Map(map);
              newMap.set(input.slug, folderPath);
              return newMap;
            });

            // In test mode, we can optionally still create the actual folder
            yield* fileSystem.makeDirectory(folderPath, { recursive: true });

            const agentsMarkdownPath = path.join(folderPath, "AGENTS.md");
            const agentsMarkdownExists = yield* fileSystem
              .exists(agentsMarkdownPath)
              .pipe(Effect.orElseSucceed(() => false));

            if (!agentsMarkdownExists && input.agentsMarkdown !== undefined) {
              yield* fileSystem.writeFileString(agentsMarkdownPath, input.agentsMarkdown);
            }

            return { folderPath };
          }).pipe(Effect.mapError((cause) => new DesktopWorkspaceError({ cause }))),
      });
    }),
  );
