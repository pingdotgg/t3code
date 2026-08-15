// @effect-diagnostics nodeBuiltinImport:off
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import * as NodePath from "node:path";

/**
 * Client-side handlers for the ACP `fs` capability.
 *
 * Agents that prefer client-mediated file access send `fs/read_text_file` and
 * `fs/write_text_file` instead of touching the disk themselves. The handlers
 * run with the same privileges as the agent process T3 already spawned, so
 * they honor absolute paths without extra confinement.
 */

const fsRequestError = (message: string, cause?: unknown) =>
  EffectAcpErrors.AcpRequestError.internalError(
    message,
    undefined,
    cause === undefined ? {} : { cause },
  );

function assertAbsolutePath(path: string) {
  return NodePath.isAbsolute(path)
    ? Effect.void
    : Effect.fail(fsRequestError(`ACP fs requests require an absolute path, received '${path}'.`));
}

/** Handles `fs/read_text_file`, applying the optional 1-based line window. */
export const acpReadTextFile = (
  fileSystem: FileSystem.FileSystem,
  request: EffectAcpSchema.ReadTextFileRequest,
): Effect.Effect<EffectAcpSchema.ReadTextFileResponse, EffectAcpErrors.AcpRequestError> =>
  Effect.gen(function* () {
    yield* assertAbsolutePath(request.path);
    const content = yield* fileSystem
      .readFileString(request.path)
      .pipe(
        Effect.mapError((cause) =>
          fsRequestError(`Could not read text file '${request.path}'.`, cause),
        ),
      );
    const line = request.line ?? undefined;
    const limit = request.limit ?? undefined;
    if (line === undefined && limit === undefined) {
      return { content };
    }
    const lines = content.split(/\r?\n/u);
    const startIndex = Math.max(0, (line ?? 1) - 1);
    const selected =
      limit === undefined ? lines.slice(startIndex) : lines.slice(startIndex, startIndex + limit);
    return { content: selected.join("\n") };
  });

/** Handles `fs/write_text_file`, creating parent directories when needed. */
export const acpWriteTextFile = (
  fileSystem: FileSystem.FileSystem,
  request: EffectAcpSchema.WriteTextFileRequest,
): Effect.Effect<EffectAcpSchema.WriteTextFileResponse, EffectAcpErrors.AcpRequestError> =>
  Effect.gen(function* () {
    yield* assertAbsolutePath(request.path);
    yield* fileSystem.makeDirectory(NodePath.dirname(request.path), { recursive: true }).pipe(
      Effect.andThen(fileSystem.writeFileString(request.path, request.content)),
      Effect.mapError((cause) =>
        fsRequestError(`Could not write text file '${request.path}'.`, cause),
      ),
    );
    return {};
  });
