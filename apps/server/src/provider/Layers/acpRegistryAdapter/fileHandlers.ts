// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

export const resolveAcpPath = (cwd: string, rawPath: string): string => {
  const root = NodePath.resolve(cwd);
  const targetPath = NodePath.resolve(root, rawPath);
  const relativePath = NodePath.relative(root, targetPath);
  if (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !NodePath.isAbsolute(relativePath))
  ) {
    return targetPath;
  }
  throw new Error(`Path must stay inside the session cwd: ${rawPath}`);
};

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
          catch: (cause) =>
            new EffectAcpErrors.AcpRequestError({
              code: -32602,
              errorMessage: `File path must stay inside the session cwd: ${request.path}`,
              data: { operation: "resolve-file-path", path: request.path },
              method: "fs/write_text_file",
              operation: "handle-request",
              cause,
            }),
        });
        yield* input.fileSystem
          .makeDirectory(NodePath.dirname(targetPath), { recursive: true })
          .pipe(
            Effect.mapError(
              (cause) =>
                new EffectAcpErrors.AcpRequestError({
                  code: -32603,
                  errorMessage: `Failed to prepare the destination for '${request.path}'.`,
                  data: { operation: "create-parent-directory", path: request.path },
                  method: "fs/write_text_file",
                  operation: "handle-request",
                  cause,
                }),
            ),
          );
        yield* input.fileSystem.writeFileString(targetPath, request.content).pipe(
          Effect.mapError(
            (cause) =>
              new EffectAcpErrors.AcpRequestError({
                code: -32603,
                errorMessage: `Failed to write text file '${request.path}'.`,
                data: { operation: "write-text-file", path: request.path },
                method: "fs/write_text_file",
                operation: "handle-request",
                cause,
              }),
          ),
        );
      }),

    onReadTextFile: (request) =>
      Effect.gen(function* () {
        const targetPath = yield* Effect.try({
          try: () => resolveAcpPath(input.cwd, request.path),
          catch: (cause) =>
            new EffectAcpErrors.AcpRequestError({
              code: -32602,
              errorMessage: `File path must stay inside the session cwd: ${request.path}`,
              data: { operation: "resolve-file-path", path: request.path },
              method: "fs/read_text_file",
              operation: "handle-request",
              cause,
            }),
        });
        const exists = yield* input.fileSystem.exists(targetPath).pipe(
          Effect.mapError(
            (cause) =>
              new EffectAcpErrors.AcpRequestError({
                code: -32603,
                errorMessage: `Failed to inspect text file '${request.path}'.`,
                data: { operation: "inspect-text-file", path: request.path },
                method: "fs/read_text_file",
                operation: "handle-request",
                cause,
              }),
          ),
        );
        if (!exists) {
          return { content: "" };
        }
        const content = yield* input.fileSystem.readFileString(targetPath).pipe(
          Effect.mapError(
            (cause) =>
              new EffectAcpErrors.AcpRequestError({
                code: -32603,
                errorMessage: `Failed to read text file '${request.path}'.`,
                data: { operation: "read-text-file", path: request.path },
                method: "fs/read_text_file",
                operation: "handle-request",
                cause,
              }),
          ),
        );
        if (request.line == null && request.limit == null) {
          return { content };
        }
        const lines = content.split("\n");
        const start = request.line != null ? Math.max(0, request.line - 1) : 0;
        const end = request.limit != null ? start + request.limit : lines.length;
        return { content: lines.slice(start, end).join("\n") };
      }),
  };
}
