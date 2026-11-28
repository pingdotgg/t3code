import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

const CLIENT_FILE_MAX_BYTES = 8 * 1024 * 1024;

function normalizeForCompare(value: string): string {
  return HostProcess.Platform.defaultValue() === "win32" ? value.toLowerCase() : value;
}

function isInsideRoot(path: Path.Path, root: string, candidate: string): boolean {
  const relative = path.relative(normalizeForCompare(root), normalizeForCompare(candidate));
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !relative.startsWith("../") &&
      !path.isAbsolute(relative))
  );
}

/** Resolve all symlinks, including the final component, before checking workspace containment. */
const resolveClientFilePath = Effect.fn("AntigravityClientFiles.resolveClientFilePath")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly cwd?: string | null;
    readonly allowedRoots: ReadonlyArray<string>;
    readonly attachmentsDir?: string;
    readonly isAllowedAttachment?: (canonicalPath: string) => Effect.Effect<boolean>;
    readonly requestPath: string;
  }) {
    const { path } = input;
    const raw = input.requestPath;
    const outside = EffectAcpErrors.AcpRequestError.invalidParams(
      `Path '${raw}' is outside the session workspace.`,
    );
    if (raw.trim().length === 0 || raw.includes("\0")) {
      return yield* outside;
    }
    let initial: string;
    if (path.isAbsolute(raw)) {
      initial = raw;
    } else if (input.cwd !== null && input.cwd !== undefined && input.cwd.trim().length > 0) {
      const cwdRoot = path.resolve(input.cwd);
      initial = `${cwdRoot}${cwdRoot.endsWith(path.sep) ? "" : path.sep}${raw}`;
    } else {
      return yield* outside;
    }
    // Node's JS `fs.realpath` (used by Effect FileSystem) folds `..` lexically before following
    // symlinks; resolve the prefix at each `..` segment first so symlink-first semantics hold.
    const rootPrefix = path.parse(initial).root;
    const splitPattern = path.sep === "\\" ? /[\\/]+/ : /\/+/;
    let candidate = rootPrefix;
    for (const segment of initial.slice(rootPrefix.length).split(splitPattern)) {
      if (segment === "" || segment === ".") continue;
      if (segment === "..") {
        const canonical = yield* input.fileSystem.realPath(candidate).pipe(Effect.option);
        if (Option.isNone(canonical)) return yield* outside;
        const info = yield* input.fileSystem.stat(canonical.value).pipe(Effect.option);
        if (Option.isNone(info) || info.value.type !== "Directory") return yield* outside;
        candidate = path.dirname(canonical.value);
        continue;
      }
      candidate = path.join(candidate, segment);
    }
    // Canonicalize the deepest existing ancestor, so a link above missing directories cannot escape.
    const missingSuffix: Array<string> = [];
    let real: string;
    while (true) {
      const canonical = yield* input.fileSystem.realPath(candidate).pipe(Effect.option);
      if (Option.isSome(canonical)) {
        real = path.join(canonical.value, ...missingSuffix);
        break;
      }
      // Walk up only past missing entries, never dangling or unreadable links.
      const entryExists = yield* input.fileSystem.readLink(candidate).pipe(
        Effect.as(true),
        Effect.catch(() => input.fileSystem.exists(candidate)),
        Effect.orElseSucceed(() => true),
      );
      const parent = path.dirname(candidate);
      if (entryExists || parent === candidate) return yield* outside;
      missingSuffix.unshift(path.basename(candidate));
      candidate = parent;
    }
    if (input.attachmentsDir !== undefined) {
      const attachmentsRoot = yield* input.fileSystem
        .realPath(input.attachmentsDir)
        .pipe(Effect.option);
      if (Option.isNone(attachmentsRoot)) {
        return yield* outside;
      }
      if (isInsideRoot(path, attachmentsRoot.value, real)) {
        const allowed =
          input.isAllowedAttachment !== undefined &&
          normalizeForCompare(path.dirname(real)) === normalizeForCompare(attachmentsRoot.value) &&
          (yield* input.isAllowedAttachment(real));
        return allowed ? real : yield* outside;
      }
    }
    const roots = yield* Effect.forEach(input.allowedRoots, (root) =>
      input.fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => root)),
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
    readonly cwd?: string | null;
    readonly allowedRoots: ReadonlyArray<string>;
    readonly attachmentsDir?: string;
    readonly isAllowedAttachment?: (canonicalPath: string) => Effect.Effect<boolean>;
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
    const bytes = yield* input.fileSystem
      .readFile(filePath)
      .pipe(
        Effect.mapError(() =>
          EffectAcpErrors.AcpRequestError.internalError(`Could not read '${input.request.path}'.`),
        ),
      );
    const text = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: () =>
        EffectAcpErrors.AcpRequestError.invalidParams(
          `File '${input.request.path}' is not a UTF-8 text file.`,
        ),
    });
    if (text.includes("\0")) {
      return yield* EffectAcpErrors.AcpRequestError.invalidParams(
        `File '${input.request.path}' contains binary data.`,
      );
    }
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
