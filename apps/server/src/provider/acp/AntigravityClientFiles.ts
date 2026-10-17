import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

/**
 * The agent gates each write behind `session/request_permission`, so only
 * path containment is checked here.
 */
const CLIENT_FILE_MAX_BYTES = 8 * 1024 * 1024;

function isInsideRoot(path: Path.Path, root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

const resolveRealOrNearestExistingPath = Effect.fn(
  "AntigravityClientFiles.resolveRealOrNearestExistingPath",
)(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly targetPath: string;
  readonly rejectDanglingLink?: EffectAcpErrors.AcpError;
}): Effect.fn.Return<string, EffectAcpErrors.AcpError> {
  const { fileSystem, path } = input;
  let current = path.resolve(input.targetPath);
  const suffix: Array<string> = [];
  while (true) {
    const real = yield* fileSystem.realPath(current).pipe(Effect.option);
    if (real._tag === "Some") {
      return suffix.length === 0 ? real.value : path.join(real.value, ...suffix.reverse());
    }
    if (input.rejectDanglingLink !== undefined) {
      const entryExists = yield* fileSystem.readLink(current).pipe(
        Effect.as(true),
        Effect.catch(() => fileSystem.exists(current)),
        Effect.orElseSucceed(() => true),
      );
      if (entryExists) {
        return yield* input.rejectDanglingLink;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(input.targetPath);
    }
    suffix.push(path.basename(current));
    current = parent;
  }
});

/**
 * Symlinks resolve before the check, including the final component, so a link
 * inside the workspace cannot read or write through to a file outside it.
 */
const resolveClientFilePath = Effect.fn("AntigravityClientFiles.resolveClientFilePath")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly allowedRoots: ReadonlyArray<string>;
    readonly requestPath: string;
  }) {
    const { path } = input;
    const outside = EffectAcpErrors.AcpRequestError.invalidParams(
      `Path '${input.requestPath}' is outside the session workspace.`,
    );
    const real = yield* resolveRealOrNearestExistingPath({
      fileSystem: input.fileSystem,
      path,
      targetPath: input.requestPath,
      rejectDanglingLink: outside,
    });
    const roots = yield* Effect.forEach(input.allowedRoots, (root) =>
      resolveRealOrNearestExistingPath({
        fileSystem: input.fileSystem,
        path,
        targetPath: root,
      }),
    );
    if (!roots.some((root) => isInsideRoot(path, root, real))) {
      return yield* outside;
    }
    return real;
  },
);

export const readAntigravityClientTextFile = Effect.fn("AntigravityClientFiles.readTextFile")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly allowedRoots: ReadonlyArray<string>;
    readonly request: EffectAcpSchema.ReadTextFileRequest;
  }): Effect.fn.Return<EffectAcpSchema.ReadTextFileResponse, EffectAcpErrors.AcpError> {
    const filePath = yield* resolveClientFilePath({ ...input, requestPath: input.request.path });
    const info = yield* input.fileSystem
      .stat(filePath)
      .pipe(
        Effect.mapError(() =>
          EffectAcpErrors.AcpRequestError.resourceNotFound(
            `File '${input.request.path}' not found.`,
          ),
        ),
      );
    if (info.type !== "File" || Number(info.size) > CLIENT_FILE_MAX_BYTES) {
      return yield* EffectAcpErrors.AcpRequestError.invalidParams(
        `File '${input.request.path}' is not a readable text file under ${CLIENT_FILE_MAX_BYTES} bytes.`,
      );
    }
    const text = yield* input.fileSystem
      .readFileString(filePath)
      .pipe(
        Effect.mapError(() =>
          EffectAcpErrors.AcpRequestError.internalError(`Could not read '${input.request.path}'.`),
        ),
      );
    const line = input.request.line ?? undefined;
    const limit = input.request.limit ?? undefined;
    if (line === undefined && limit === undefined) {
      return { content: text };
    }
    // ACP lines are 1-indexed. `limit` is a line count.
    const lines = text.split("\n");
    const start = Math.max(0, (line ?? 1) - 1);
    const end = limit === undefined ? lines.length : Math.min(lines.length, start + limit);
    return { content: lines.slice(start, end).join("\n") };
  },
);

export const writeAntigravityClientTextFile = Effect.fn("AntigravityClientFiles.writeTextFile")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly allowedRoots: ReadonlyArray<string>;
    readonly request: EffectAcpSchema.WriteTextFileRequest;
  }): Effect.fn.Return<EffectAcpSchema.WriteTextFileResponse, EffectAcpErrors.AcpError> {
    const filePath = yield* resolveClientFilePath({ ...input, requestPath: input.request.path });
    yield* input.fileSystem.makeDirectory(input.path.dirname(filePath), { recursive: true }).pipe(
      Effect.andThen(input.fileSystem.writeFileString(filePath, input.request.content)),
      Effect.mapError(() =>
        EffectAcpErrors.AcpRequestError.internalError(`Could not write '${input.request.path}'.`),
      ),
    );
    return {};
  },
);
