// @effect-diagnostics nodeBuiltinImport:off
import * as path from "node:path";

import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

export const resolveAcpPath = (cwd: string, rawPath: string): string => {
  const root = path.resolve(cwd);
  const targetPath = path.resolve(root, rawPath);
  const relativePath = path.relative(root, targetPath);
  if (relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))) {
    return targetPath;
  }
  throw new Error(`Path must stay inside the session cwd: ${rawPath}`);
};

const acpFsError = (operation: string, rawPath: string, cause: unknown) =>
  new EffectAcpErrors.AcpRequestError({
    code: -32603,
    errorMessage: `Failed to ${operation} '${rawPath}': ${
      cause instanceof Error ? cause.message : String(cause)
    }`,
  });

export function buildFileHandlers(input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly cwd: string;
}): {
  readonly onReadTextFile: (
    request: EffectAcpSchema.ReadTextFileRequest,
  ) => Effect.Effect<EffectAcpSchema.ReadTextFileResponse, EffectAcpErrors.AcpError>;
  readonly onWriteTextFile: (
    request: EffectAcpSchema.WriteTextFileRequest,
  ) => Effect.Effect<EffectAcpSchema.WriteTextFileResponse | void, EffectAcpErrors.AcpError>;
} {
  return {
    onWriteTextFile: (request) =>
      Effect.gen(function* () {
        const targetPath = yield* Effect.try({
          try: () => resolveAcpPath(input.cwd, request.path),
          catch: (cause) => acpFsError("resolve file path", request.path, cause),
        });
        yield* input.fileSystem.makeDirectory(path.dirname(targetPath), {
          recursive: true,
        });
        yield* input.fileSystem.writeFileString(targetPath, request.content);
      }).pipe(Effect.mapError((cause) => acpFsError("write file", request.path, cause))),

    onReadTextFile: (request) =>
      Effect.gen(function* () {
        const targetPath = yield* Effect.try({
          try: () => resolveAcpPath(input.cwd, request.path),
          catch: (cause) => acpFsError("resolve file path", request.path, cause),
        });
        const exists = yield* input.fileSystem.exists(targetPath);
        if (!exists) {
          return { content: "" };
        }
        const content = yield* input.fileSystem.readFileString(targetPath);
        if (request.line == null && request.limit == null) {
          return { content };
        }
        const lines = content.split("\n");
        const start = request.line != null ? Math.max(0, request.line - 1) : 0;
        const end = request.limit != null ? start + request.limit : lines.length;
        return { content: lines.slice(start, end).join("\n") };
      }).pipe(Effect.mapError((cause) => acpFsError("read file", request.path, cause))),
  };
}
