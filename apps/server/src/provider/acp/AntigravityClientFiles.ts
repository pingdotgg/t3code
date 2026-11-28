import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

const CLIENT_FILE_MAX_BYTES = 8 * 1024 * 1024;
const GIT_POINTER_MAX_BYTES = 4096;
const READ_CHUNK_MAX_BYTES = 64 * 1024;
const GITDIR_PREFIX = /^gitdir:[ \t]*/u;
// Git strips only the line terminator, so pathname spaces are part of the path.
const decodeGitfilePointer = Schema.decodeUnknownOption(
  Schema.String.check(Schema.isPattern(/^gitdir:[ \t]*[^\r\n]+(?:\r?\n)?$/u)),
);
const decodeMetadataLine = Schema.decodeUnknownOption(
  Schema.String.check(Schema.isPattern(/^[^\r\n]+(?:\r?\n)?$/u)),
);

export interface VerifiedFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

export interface VerifiedClientFileRoot {
  readonly path: string;
  readonly identity: VerifiedFileIdentity;
}

export type ClientFileRoot = string | VerifiedClientFileRoot;

function extractFileIdentity(info: FileSystem.File.Info): VerifiedFileIdentity | undefined {
  return Option.isSome(info.ino) ? { dev: info.dev, ino: info.ino.value } : undefined;
}

function sameFileIdentity(a: VerifiedFileIdentity, b: VerifiedFileIdentity | undefined): boolean {
  return b !== undefined && a.dev === b.dev && a.ino === b.ino;
}

// Windows has no O_NOFOLLOW, so there the callers' identity checks bind the opened file.
const openNoFollow = (fileSystem: FileSystem.FileSystem, filePath: string) =>
  fileSystem.open(filePath, { flag: "r", noFollow: true }).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "BadArgument",
      () => fileSystem.open(filePath, { flag: "r" }),
    ),
  );

/**
 * Read at most `maxBytes + 1` bytes in chunks sized to the observed file size, so a growing file is
 * never buffered whole and a small file never allocates a buffer sized for the limit.
 */
const readBoundedBytes = Effect.fn("AntigravityClientFiles.readBoundedBytes")(function* (
  file: FileSystem.File,
  maxBytes: number,
  expectedSize: number,
) {
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  let chunkSize = Math.min(expectedSize + 1, READ_CHUNK_MAX_BYTES);
  while (total <= maxBytes) {
    const chunk = yield* file.readAlloc(Math.min(chunkSize, maxBytes + 1 - total));
    if (Option.isNone(chunk)) break;
    chunks.push(chunk.value);
    total += chunk.value.length;
    chunkSize = Math.min(
      expectedSize > total ? expectedSize - total + 1 : chunkSize * 2,
      READ_CHUNK_MAX_BYTES,
    );
  }
  return total > maxBytes ? undefined : Buffer.concat(chunks, total);
});

const readGitPointer = Effect.fn("AntigravityClientFiles.readGitPointer")(function* (
  fileSystem: FileSystem.FileSystem,
  filePath: string,
  lstatInfo: FileSystem.File.Info,
) {
  const lstatId = extractFileIdentity(lstatInfo);
  if (
    lstatInfo.type !== "File" ||
    Number(lstatInfo.size) > GIT_POINTER_MAX_BYTES ||
    lstatId === undefined
  ) {
    return undefined;
  }
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* openNoFollow(fileSystem, filePath);
      const fdInfo = yield* file.stat;
      if (
        fdInfo.type !== "File" ||
        Number(fdInfo.size) > GIT_POINTER_MAX_BYTES ||
        !sameFileIdentity(lstatId, extractFileIdentity(fdInfo))
      ) {
        return undefined;
      }
      const bytes = yield* readBoundedBytes(file, GIT_POINTER_MAX_BYTES, Number(fdInfo.size));
      if (bytes === undefined) return undefined;
      const contents = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        catch: () => undefined,
      }).pipe(Effect.option);
      return Option.isSome(contents) ? { contents: contents.value, identity: lstatId } : undefined;
    }),
  );
});

function lineValue(line: Option.Option<string>, prefix = /^/u): string | undefined {
  return (
    Option.getOrUndefined(line)
      ?.replace(prefix, "")
      .replace(/\r?\n$/u, "") || undefined
  );
}

const readMetadataLine = (fileSystem: FileSystem.FileSystem, filePath: string) =>
  fileSystem.lstat(filePath).pipe(
    Effect.flatMap((info) => readGitPointer(fileSystem, filePath, info)),
    Effect.map((pointer) => lineValue(decodeMetadataLine(pointer?.contents))),
  );

const isVerifiedRootIntact = Effect.fn("AntigravityClientFiles.isVerifiedRootIntact")(
  function* (fileSystem: FileSystem.FileSystem, root: VerifiedClientFileRoot) {
    if ((yield* fileSystem.realPath(root.path)) !== root.path) return false;
    const info = yield* fileSystem.lstat(root.path);
    return info.type === "Directory" && sameFileIdentity(root.identity, extractFileIdentity(info));
  },
  Effect.orElseSucceed(() => false),
);

/**
 * Find the backing directory of the linked worktree containing `cwd`. Every pointer must be a
 * bounded single-line regular file, the backing directory must be registered under its common
 * directory's `worktrees`, and its `gitdir` backlink must name this exact `.git` file.
 */
export const resolveGitWorktreeDirectory = Effect.fn(
  "AntigravityClientFiles.resolveGitWorktreeDirectory",
)(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly cwd: string | null | undefined;
  }) {
    const { fileSystem, path } = input;
    const cwd = input.cwd;
    if (!cwd?.trim()) return undefined;
    // Walk the canonical parents, so a workspace symlinked into a worktree still finds its `.git`.
    let dir = yield* fileSystem.realPath(path.resolve(cwd));
    while (true) {
      const dotGit = path.join(dir, ".git");
      const info = yield* fileSystem.lstat(dotGit).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.undefined,
        ),
      );
      if (info === undefined) {
        const parent = path.dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
        continue;
      }
      const pointer = yield* readGitPointer(fileSystem, dotGit, info);
      const gitdir = lineValue(decodeGitfilePointer(pointer?.contents), GITDIR_PREFIX);
      if (pointer === undefined || !gitdir) return undefined;

      const realDotGit = yield* fileSystem.realPath(dotGit);
      if (realDotGit !== dotGit) return undefined;
      const realDotGitInfo = yield* fileSystem.lstat(realDotGit);
      if (
        realDotGitInfo.type !== "File" ||
        !sameFileIdentity(pointer.identity, extractFileIdentity(realDotGitInfo))
      ) {
        return undefined;
      }

      const gitDirectory = yield* fileSystem.realPath(path.resolve(dir, gitdir));
      const gitDirInfo = yield* fileSystem.lstat(gitDirectory);
      const gitDirIdentity = extractFileIdentity(gitDirInfo);
      if (gitDirInfo.type !== "Directory" || gitDirIdentity === undefined) return undefined;

      const commonDir = yield* readMetadataLine(fileSystem, path.join(gitDirectory, "commondir"));
      if (!commonDir) return undefined;
      const realCommonDir = yield* fileSystem.realPath(path.resolve(gitDirectory, commonDir));
      if (
        (yield* fileSystem.lstat(realCommonDir)).type !== "Directory" ||
        path.dirname(gitDirectory) !== path.join(realCommonDir, "worktrees")
      ) {
        return undefined;
      }

      const backlink = yield* readMetadataLine(fileSystem, path.join(gitDirectory, "gitdir"));
      if (!backlink) return undefined;
      const realTarget = yield* fileSystem.realPath(path.resolve(gitDirectory, backlink));
      const targetInfo = yield* fileSystem.lstat(realTarget);
      if (
        targetInfo.type !== "File" ||
        realTarget !== realDotGit ||
        !sameFileIdentity(pointer.identity, extractFileIdentity(targetInfo))
      ) {
        return undefined;
      }

      const root: VerifiedClientFileRoot = { path: gitDirectory, identity: gitDirIdentity };
      return (yield* isVerifiedRootIntact(fileSystem, root)) ? root : undefined;
    }
  },
  Effect.orElseSucceed(() => undefined),
);

function isInsideRoot(path: Path.Path, root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/**
 * Resolve all symlinks, including the final component, before checking workspace containment.
 * A verified root is matched at its pinned path and identity, never re-canonicalized.
 */
const resolveClientFilePath = Effect.fn("AntigravityClientFiles.resolveClientFilePath")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly cwd?: string | null;
    readonly allowedRoots: ReadonlyArray<ClientFileRoot>;
    readonly requestPath: string;
  }) {
    const { fileSystem, path } = input;
    const outside = EffectAcpErrors.AcpRequestError.invalidParams(
      `Path '${input.requestPath}' is outside the session workspace.`,
    );
    let resolved: string;
    if (path.isAbsolute(input.requestPath)) {
      resolved = path.resolve(input.requestPath);
    } else if (input.cwd !== null && input.cwd !== undefined) {
      resolved = path.resolve(input.cwd, input.requestPath);
    } else {
      return yield* outside;
    }
    // Canonicalize the deepest existing ancestor, so a link above missing directories cannot escape.
    let candidate = resolved;
    const missingSuffix: Array<string> = [];
    let real: string;
    while (true) {
      const canonical = yield* fileSystem.realPath(candidate).pipe(Effect.option);
      if (Option.isSome(canonical)) {
        real = path.join(canonical.value, ...missingSuffix);
        break;
      }
      // Walk up only past missing entries, never dangling or unreadable links.
      const entryExists = yield* fileSystem.readLink(candidate).pipe(
        Effect.as(true),
        Effect.catch(() => fileSystem.exists(candidate)),
        Effect.orElseSucceed(() => true),
      );
      const parent = path.dirname(candidate);
      if (entryExists || parent === candidate) return yield* outside;
      missingSuffix.unshift(path.basename(candidate));
      candidate = parent;
    }
    let verifiedRoot: VerifiedClientFileRoot | undefined;
    for (const root of input.allowedRoots) {
      if (typeof root === "string") {
        const realRoot = yield* fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => root));
        if (isInsideRoot(path, realRoot, real)) return { filePath: real, verifiedRoot: undefined };
      } else if (
        verifiedRoot === undefined &&
        isInsideRoot(path, root.path, real) &&
        (yield* isVerifiedRootIntact(fileSystem, root))
      ) {
        verifiedRoot = root;
      }
    }
    if (verifiedRoot === undefined) return yield* outside;
    return { filePath: real, verifiedRoot };
  },
);

export const readAntigravityClientTextFile = Effect.fn("AntigravityClientFiles.readTextFile")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly cwd?: string | null;
    readonly allowedRoots: ReadonlyArray<ClientFileRoot>;
    readonly request: EffectAcpSchema.ReadTextFileRequest;
  }): Effect.fn.Return<EffectAcpSchema.ReadTextFileResponse, EffectAcpErrors.AcpError> {
    const { fileSystem } = input;
    const { filePath, verifiedRoot } = yield* resolveClientFilePath({
      ...input,
      requestPath: input.request.path,
    });
    const notFound = EffectAcpErrors.AcpRequestError.resourceNotFound(
      `File '${input.request.path}' not found.`,
    );
    const outside = EffectAcpErrors.AcpRequestError.invalidParams(
      `Path '${input.request.path}' is outside the session workspace.`,
    );
    const notText = EffectAcpErrors.AcpRequestError.invalidParams(
      `File '${input.request.path}' is not a readable text file under ${CLIENT_FILE_MAX_BYTES} bytes.`,
    );
    const unreadable = EffectAcpErrors.AcpRequestError.internalError(
      `Could not read '${input.request.path}'.`,
    );
    // Checked before opening so a FIFO is refused instead of blocking the open.
    const info = yield* fileSystem.stat(filePath).pipe(Effect.mapError(() => notFound));
    if (info.type !== "File" || Number(info.size) > CLIENT_FILE_MAX_BYTES) {
      return yield* notText;
    }
    const bytes = yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* openNoFollow(fileSystem, filePath).pipe(
          Effect.catch((error) =>
            error.reason._tag === "NotFound"
              ? Effect.fail(notFound)
              : fileSystem.lstat(filePath).pipe(
                  Effect.option,
                  Effect.flatMap((entry) =>
                    Effect.fail(
                      Option.isSome(entry) && entry.value.type === "SymbolicLink"
                        ? outside
                        : unreadable,
                    ),
                  ),
                ),
          ),
        );
        const fdInfo = yield* file.stat.pipe(Effect.mapError(() => unreadable));
        if (fdInfo.type !== "File" || Number(fdInfo.size) > CLIENT_FILE_MAX_BYTES) {
          return yield* notText;
        }
        const read = yield* readBoundedBytes(file, CLIENT_FILE_MAX_BYTES, Number(fdInfo.size)).pipe(
          Effect.mapError(() => unreadable),
        );
        if (read === undefined) return yield* notText;
        if (verifiedRoot !== undefined) {
          const fdIdentity = extractFileIdentity(fdInfo);
          const stillInside = yield* Effect.gen(function* () {
            if (fdIdentity === undefined) return false;
            if (!(yield* isVerifiedRootIntact(fileSystem, verifiedRoot))) return false;
            if ((yield* fileSystem.realPath(filePath)) !== filePath) return false;
            return sameFileIdentity(
              fdIdentity,
              extractFileIdentity(yield* fileSystem.lstat(filePath)),
            );
          }).pipe(Effect.orElseSucceed(() => false));
          if (!stillInside) return yield* outside;
        }
        return read;
      }),
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
