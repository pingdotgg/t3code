// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";

import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";

import * as WorkspacePaths from "./WorkspacePaths.ts";

export const CONTEXT_DIRECTORY_NAME = ".context";
export const CONTEXT_GITIGNORE_ENTRY = ".context/";
export const STANDARD_CONTEXT_MARKDOWN_FILES = [
  "brief.md",
  "plan.md",
  "decisions.md",
  "handoff.md",
  "review.md",
  "checks.md",
] as const;

export class WorkspaceContextOperationError extends Schema.TaggedErrorClass<WorkspaceContextOperationError>()(
  "WorkspaceContextOperationError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    operationPath: Schema.String,
    operation: Schema.Literals([
      "make-directory",
      "read-file",
      "write-file",
      "rename-file",
      "remove-file",
      "stat-file",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Workspace context operation '${this.operation}' failed at '${this.operationPath}' for '${this.relativePath}' in '${this.workspaceRoot}'.`;
  }
}

export class WorkspaceContextPathError extends Schema.TaggedErrorClass<WorkspaceContextPathError>()(
  "WorkspaceContextPathError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    reason: Schema.Literals(["outside-context", "not-markdown"]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "outside-context":
        return `Workspace context path must stay inside .context/: ${this.relativePath}`;
      case "not-markdown":
        return `Workspace context path must target a markdown file: ${this.relativePath}`;
    }
  }
}

export const WorkspaceContextError = Schema.Union([
  WorkspaceContextOperationError,
  WorkspaceContextPathError,
  WorkspacePaths.WorkspacePathOutsideRootError,
]);
export type WorkspaceContextError = typeof WorkspaceContextError.Type;

export interface WorkspaceContextFile {
  readonly relativePath: string;
  readonly contents: string;
}

export class WorkspaceContext extends Context.Service<
  WorkspaceContext,
  {
    readonly initialize: (input: {
      readonly workspaceRoot: string;
    }) => Effect.Effect<
      { readonly relativePath: typeof CONTEXT_DIRECTORY_NAME },
      WorkspaceContextError
    >;
    readonly readMarkdownFile: (input: {
      readonly workspaceRoot: string;
      readonly relativePath: string;
    }) => Effect.Effect<WorkspaceContextFile, WorkspaceContextError>;
    readonly writeMarkdownFile: (input: {
      readonly workspaceRoot: string;
      readonly relativePath: string;
      readonly contents: string;
    }) => Effect.Effect<{ readonly relativePath: string }, WorkspaceContextError>;
  }
>()("t3/workspace/WorkspaceContext") {}

function toPosixRelativePath(input: string): string {
  return input.replaceAll("\\", "/");
}

function hasGitignoreEntry(contents: string): boolean {
  return contents
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .some((line) => line === CONTEXT_GITIGNORE_ENTRY || line === CONTEXT_DIRECTORY_NAME);
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;

  const resolveContextMarkdownPath = Effect.fn("WorkspaceContext.resolveContextMarkdownPath")(
    function* (input: { readonly workspaceRoot: string; readonly relativePath: string }) {
      const trimmed = input.relativePath.trim();
      const relativePath = trimmed.startsWith(`${CONTEXT_DIRECTORY_NAME}/`)
        ? trimmed.slice(CONTEXT_DIRECTORY_NAME.length + 1)
        : trimmed;
      const resolved = yield* workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: input.workspaceRoot,
        relativePath: path.join(CONTEXT_DIRECTORY_NAME, relativePath),
      });
      const contextRelativePath = toPosixRelativePath(
        path.relative(
          path.join(input.workspaceRoot, CONTEXT_DIRECTORY_NAME),
          resolved.absolutePath,
        ),
      );
      if (
        contextRelativePath.length === 0 ||
        contextRelativePath === "." ||
        contextRelativePath === ".." ||
        contextRelativePath.startsWith("../") ||
        path.isAbsolute(contextRelativePath)
      ) {
        return yield* new WorkspaceContextPathError({
          workspaceRoot: input.workspaceRoot,
          relativePath: input.relativePath,
          reason: "outside-context",
        });
      }
      if (!contextRelativePath.endsWith(".md")) {
        return yield* new WorkspaceContextPathError({
          workspaceRoot: input.workspaceRoot,
          relativePath: input.relativePath,
          reason: "not-markdown",
        });
      }

      return {
        absolutePath: resolved.absolutePath,
        relativePath: `${CONTEXT_DIRECTORY_NAME}/${contextRelativePath}`,
      };
    },
  );

  const ensureGitignoreEntry = Effect.fn("WorkspaceContext.ensureGitignoreEntry")(function* (
    workspaceRoot: string,
  ) {
    const gitignorePath = path.join(workspaceRoot, ".gitignore");
    const existing = yield* fileSystem.readFileString(gitignorePath).pipe(
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed("")
          : Effect.fail(
              new WorkspaceContextOperationError({
                workspaceRoot,
                relativePath: ".gitignore",
                operationPath: gitignorePath,
                operation: "read-file",
                cause,
              }),
            ),
      ),
    );
    if (hasGitignoreEntry(existing)) {
      return;
    }

    const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    const nextContents = `${existing}${separator}${CONTEXT_GITIGNORE_ENTRY}\n`;
    yield* fileSystem.writeFileString(gitignorePath, nextContents).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceContextOperationError({
            workspaceRoot,
            relativePath: ".gitignore",
            operationPath: gitignorePath,
            operation: "write-file",
            cause,
          }),
      ),
    );
  });

  const writeFileIfMissing = Effect.fn("WorkspaceContext.writeFileIfMissing")(function* (input: {
    readonly workspaceRoot: string;
    readonly relativePath: string;
    readonly absolutePath: string;
    readonly contents: string;
  }) {
    const existing = yield* fileSystem.stat(input.absolutePath).pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(null)
            : Effect.fail(
                new WorkspaceContextOperationError({
                  workspaceRoot: input.workspaceRoot,
                  relativePath: input.relativePath,
                  operationPath: input.absolutePath,
                  operation: "stat-file",
                  cause,
                }),
              ),
        onSuccess: Effect.succeed,
      }),
    );
    if (existing) {
      return;
    }
    yield* fileSystem.writeFileString(input.absolutePath, input.contents).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceContextOperationError({
            workspaceRoot: input.workspaceRoot,
            relativePath: input.relativePath,
            operationPath: input.absolutePath,
            operation: "write-file",
            cause,
          }),
      ),
    );
  });

  const initialize: WorkspaceContext["Service"]["initialize"] = Effect.fn(
    "WorkspaceContext.initialize",
  )(function* (input) {
    const contextDirectoryPath = path.join(input.workspaceRoot, CONTEXT_DIRECTORY_NAME);
    yield* fileSystem.makeDirectory(contextDirectoryPath, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceContextOperationError({
            workspaceRoot: input.workspaceRoot,
            relativePath: CONTEXT_DIRECTORY_NAME,
            operationPath: contextDirectoryPath,
            operation: "make-directory",
            cause,
          }),
      ),
    );

    for (const fileName of STANDARD_CONTEXT_MARKDOWN_FILES) {
      yield* writeFileIfMissing({
        workspaceRoot: input.workspaceRoot,
        relativePath: `${CONTEXT_DIRECTORY_NAME}/${fileName}`,
        absolutePath: path.join(contextDirectoryPath, fileName),
        contents: "",
      });
    }
    yield* ensureGitignoreEntry(input.workspaceRoot);

    return { relativePath: CONTEXT_DIRECTORY_NAME };
  });

  const readMarkdownFile: WorkspaceContext["Service"]["readMarkdownFile"] = Effect.fn(
    "WorkspaceContext.readMarkdownFile",
  )(function* (input) {
    const target = yield* resolveContextMarkdownPath(input);
    const contents = yield* fileSystem.readFileString(target.absolutePath).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceContextOperationError({
            workspaceRoot: input.workspaceRoot,
            relativePath: target.relativePath,
            operationPath: target.absolutePath,
            operation: "read-file",
            cause,
          }),
      ),
    );
    return {
      relativePath: target.relativePath,
      contents,
    };
  });

  const writeMarkdownFile: WorkspaceContext["Service"]["writeMarkdownFile"] = Effect.fn(
    "WorkspaceContext.writeMarkdownFile",
  )(function* (input) {
    yield* initialize({ workspaceRoot: input.workspaceRoot });
    const target = yield* resolveContextMarkdownPath(input);
    const parentDirectory = path.dirname(target.absolutePath);
    yield* fileSystem.makeDirectory(parentDirectory, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceContextOperationError({
            workspaceRoot: input.workspaceRoot,
            relativePath: target.relativePath,
            operationPath: parentDirectory,
            operation: "make-directory",
            cause,
          }),
      ),
    );

    const tempSuffix = yield* Effect.all({
      nowMs: Clock.currentTimeMillis,
      random: Random.next,
    }).pipe(Effect.map(({ nowMs, random }) => `${nowMs}.${String(random).slice(2)}`));
    const tempPath = path.join(
      parentDirectory,
      `.${path.basename(target.absolutePath)}.${tempSuffix}.tmp`,
    );
    yield* fileSystem.writeFileString(tempPath, input.contents).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceContextOperationError({
            workspaceRoot: input.workspaceRoot,
            relativePath: target.relativePath,
            operationPath: tempPath,
            operation: "write-file",
            cause,
          }),
      ),
    );
    yield* Effect.tryPromise({
      try: () => NodeFSP.rename(tempPath, target.absolutePath),
      catch: (cause) =>
        new WorkspaceContextOperationError({
          workspaceRoot: input.workspaceRoot,
          relativePath: target.relativePath,
          operationPath: target.absolutePath,
          operation: "rename-file",
          cause,
        }),
    }).pipe(
      Effect.catch((error) =>
        Effect.tryPromise({
          try: () => NodeFSP.rm(tempPath, { force: true }),
          catch: (cause) =>
            new WorkspaceContextOperationError({
              workspaceRoot: input.workspaceRoot,
              relativePath: target.relativePath,
              operationPath: tempPath,
              operation: "remove-file",
              cause,
            }),
        }).pipe(
          Effect.ignore,
          Effect.flatMap(() => Effect.fail(error)),
        ),
      ),
    );

    return { relativePath: target.relativePath };
  });

  return WorkspaceContext.of({ initialize, readMarkdownFile, writeMarkdownFile });
});

export const layer = Layer.effect(WorkspaceContext, make);
