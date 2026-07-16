// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { DirEntry, FileStat, FilesystemCapability } from "@t3tools/plugin-sdk";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { PluginWorkspaceGrants } from "../PluginWorkspaceGrants.ts";

const FILE_MAX_BYTES = 16 * 1024 * 1024;
const LIST_RECURSIVE_MAX_ENTRIES = 500;
const READ_CHUNK_BYTES = 64 * 1024;

type FilesystemOperation =
  | "list-roots"
  | "read-file"
  | "read-file-string"
  | "read-file-string-capped"
  | "write-file"
  | "create-file-exclusive"
  | "exists"
  | "stat"
  | "list-dir"
  | "list-dir-recursive"
  | "make-directory"
  | "remove"
  | "rename";

interface FilesystemPathContext {
  readonly root: string;
  readonly relativePath: string;
}

export class FilesystemPathError extends Schema.TaggedErrorClass<FilesystemPathError>()(
  "FilesystemPathError",
  {
    root: Schema.String,
    relativePath: Schema.String,
    operation: Schema.String,
    reason: Schema.String,
    data: Schema.optional(Schema.Unknown),
  },
) {
  override get message(): string {
    return `Filesystem path '${this.relativePath}' in root '${this.root}' is not allowed: ${this.reason}`;
  }
}

export class FilesystemIoError extends Schema.TaggedErrorClass<FilesystemIoError>()(
  "FilesystemIoError",
  {
    root: Schema.String,
    relativePath: Schema.String,
    operation: Schema.String,
    reason: Schema.String,
    data: Schema.optional(Schema.Unknown),
  },
) {
  override get message(): string {
    return `Filesystem operation '${this.operation}' failed for '${this.relativePath}' in root '${this.root}': ${this.reason}`;
  }
}

type FilesystemError = FilesystemPathError | FilesystemIoError;

class NodePathNotFound extends Error {
  readonly _tag = "NodePathNotFound";
}

const isFilesystemIoError = Schema.is(FilesystemIoError);

const isNodeNotFound = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause as { readonly code?: unknown }).code === "ENOENT";

const isNodeSymlinkLoop = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause as { readonly code?: unknown }).code === "ELOOP";

const pathError = (
  context: FilesystemPathContext,
  operation: FilesystemOperation,
  reason: string,
  data?: unknown,
) =>
  new FilesystemPathError({
    ...context,
    operation,
    reason,
    ...(data === undefined ? {} : { data }),
  });

const ioError = (
  context: FilesystemPathContext,
  operation: FilesystemOperation,
  reason: string,
  data?: unknown,
) =>
  new FilesystemIoError({
    ...context,
    operation,
    reason,
    ...(data === undefined ? {} : { data }),
  });

const containsRealPath = (realRoot: string, realTarget: string): boolean => {
  const relative = NodePath.relative(realRoot, realTarget);
  // NOT `relative.startsWith("..")`: that also matches legitimate in-root names
  // that merely BEGIN with two dots — `..cache`, `..config` — which realPath had
  // already confirmed are inside the granted root. Only an exact ".." or a leading
  // "../" segment means the target escaped.
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative))
  );
};

const isAbsoluteRelativePath = (relativePath: string): boolean =>
  NodePath.isAbsolute(relativePath) ||
  relativePath.startsWith("\\") ||
  /^[a-zA-Z]:[\\/]/u.test(relativePath);

function parseRelativePath(
  context: FilesystemPathContext,
  operation: FilesystemOperation,
): Effect.Effect<ReadonlyArray<string>, FilesystemPathError> {
  if (context.relativePath.includes("\0")) {
    return Effect.fail(pathError(context, operation, "path contains a NUL byte"));
  }
  if (isAbsoluteRelativePath(context.relativePath)) {
    return Effect.fail(pathError(context, operation, "relativePath must not be absolute"));
  }
  const normalized = context.relativePath.replace(/\\/gu, "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (segments.includes("..")) {
    return Effect.fail(pathError(context, operation, "relativePath must not contain '..'"));
  }
  return Effect.succeed(segments);
}

const outputRelativePath = (base: string, name: string) =>
  [...base.replace(/\\/gu, "/").split("/").filter(Boolean), name].join("/");

const statType = (stat: NodeFS.Stats): FileStat["type"] => {
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "directory";
  return "other";
};

const lstatOrNull = (
  absPath: string,
  context: FilesystemPathContext,
  operation: FilesystemOperation,
  reason: string,
) =>
  Effect.tryPromise({
    try: () => NodeFSP.lstat(absPath),
    catch: (cause) =>
      isNodeNotFound(cause)
        ? new NodePathNotFound()
        : ioError(context, operation, reason, {
            resolvedPath: absPath,
            cause,
          }),
  }).pipe(
    Effect.catch((error) =>
      error instanceof NodePathNotFound ? Effect.succeed(null) : Effect.fail(error),
    ),
  );

const readProjectRoots = (snapshots: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]) =>
  snapshots
    .getShellSnapshot()
    .pipe(Effect.map((snapshot) => snapshot.projects.map((p) => p.workspaceRoot)));

function snapshotGrantedRoots(input: {
  readonly snapshots: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
  readonly grants: PluginWorkspaceGrants;
}): Effect.Effect<ReadonlyArray<string>, Error> {
  return Effect.gen(function* () {
    const projectRoots = yield* readProjectRoots(input.snapshots);
    const worktreeRoots = [...(yield* input.grants.snapshot())];
    return [...new Set([...projectRoots, ...worktreeRoots])];
  });
}

function requireRoot(input: {
  readonly snapshots: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
  readonly grants: PluginWorkspaceGrants;
  readonly context: FilesystemPathContext;
  readonly operation: FilesystemOperation;
}): Effect.Effect<
  { readonly roots: ReadonlyArray<string>; readonly realRoot: string },
  FilesystemError
> {
  return Effect.gen(function* () {
    const roots = yield* snapshotGrantedRoots(input).pipe(
      Effect.mapError((cause) =>
        ioError(input.context, input.operation, "failed to read granted roots", { cause }),
      ),
    );
    if (!roots.includes(input.context.root)) {
      return yield* pathError(input.context, input.operation, "root is not granted", {
        roots,
      });
    }
    const realRoot = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(input.context.root),
      catch: (cause) =>
        ioError(input.context, input.operation, "failed to resolve root", { cause }),
    });
    return { roots, realRoot };
  });
}

function realpathExistingTarget(input: {
  readonly context: FilesystemPathContext;
  readonly operation: FilesystemOperation;
  readonly realRoot: string;
  readonly segments: ReadonlyArray<string>;
}): Effect.Effect<string, FilesystemError> {
  return Effect.gen(function* () {
    const logicalTarget = NodePath.join(input.context.root, ...input.segments);
    const realTarget = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(logicalTarget),
      catch: (cause) =>
        isNodeNotFound(cause)
          ? pathError(input.context, input.operation, "path does not exist", {
              resolvedPath: logicalTarget,
              cause,
            })
          : ioError(input.context, input.operation, "failed to resolve path", {
              resolvedPath: logicalTarget,
              cause,
            }),
    });
    if (!containsRealPath(input.realRoot, realTarget)) {
      // Deliberately no `data`: the resolved target is an out-of-root host
      // path (e.g. a symlink-escape destination) and must not leak host
      // filesystem topology through plugin-visible error payloads.
      return yield* pathError(input.context, input.operation, "path resolves outside root");
    }
    return realTarget;
  });
}

/**
 * Resolve (optionally creating) each parent segment to its real path,
 * verifying containment at every step.
 *
 * KNOWN LIMITATION (full-trust TOCTOU): each segment is realpath-resolved and
 * containment-checked, but the mutating open happens afterwards against
 * `join(realParent, leaf)` with `O_NOFOLLOW` on the LEAF only. An attacker
 * with local write access who swaps an already-resolved real parent directory
 * for a symlink between resolution and the open wins that race. Node exposes
 * no `openat`-style per-segment `O_NOFOLLOW` walk, so this is accepted under
 * the plugin full-trust model: the boundary defends against malicious PATH
 * STRINGS handled by well-behaved in-process plugins, not against a
 * concurrent local attacker mutating the workspace. The realpath+containment
 * walk here remains the backstop that stops every non-racing escape.
 */
function resolveParent(input: {
  readonly context: FilesystemPathContext;
  readonly operation: FilesystemOperation;
  readonly realRoot: string;
  readonly parentSegments: ReadonlyArray<string>;
  readonly create: boolean;
}): Effect.Effect<string, FilesystemError> {
  return Effect.gen(function* () {
    let current = input.realRoot;
    for (const segment of input.parentSegments) {
      if (segment === ".") continue;
      const candidate = NodePath.join(current, segment);
      let lstat = yield* lstatOrNull(
        candidate,
        input.context,
        input.operation,
        "failed to inspect parent path",
      );
      if (lstat === null) {
        if (!input.create) {
          return yield* ioError(input.context, input.operation, "parent path does not exist", {
            resolvedPath: candidate,
          });
        }
        yield* Effect.tryPromise({
          try: () => NodeFSP.mkdir(candidate),
          catch: (cause) =>
            ioError(input.context, input.operation, "failed to create directory", {
              resolvedPath: candidate,
              cause,
            }),
        });
        lstat = yield* Effect.tryPromise({
          try: () => NodeFSP.lstat(candidate),
          catch: (cause) =>
            ioError(input.context, input.operation, "failed to inspect created directory", {
              resolvedPath: candidate,
              cause,
            }),
        });
      }
      const realCandidate = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(candidate),
        catch: (cause) =>
          ioError(input.context, input.operation, "failed to resolve parent path", {
            resolvedPath: candidate,
            cause,
          }),
      });
      if (!containsRealPath(input.realRoot, realCandidate)) {
        // No `data`: the resolved candidate is an out-of-root host path and
        // must not leak through plugin-visible error payloads.
        return yield* pathError(input.context, input.operation, "parent resolves outside root");
      }
      const stat = lstat.isSymbolicLink()
        ? yield* Effect.tryPromise({
            try: () => NodeFSP.stat(realCandidate),
            catch: (cause) =>
              ioError(input.context, input.operation, "failed to inspect resolved parent", {
                resolvedPath: realCandidate,
                cause,
              }),
          })
        : lstat;
      if (!stat.isDirectory()) {
        return yield* ioError(input.context, input.operation, "parent path is not a directory", {
          resolvedPath: realCandidate,
        });
      }
      current = realCandidate;
    }
    return current;
  });
}

function resolveLeafParent(input: {
  readonly context: FilesystemPathContext;
  readonly operation: FilesystemOperation;
  readonly realRoot: string;
  readonly segments: ReadonlyArray<string>;
  readonly createParent: boolean;
}): Effect.Effect<{ readonly realParent: string; readonly leaf: string }, FilesystemError> {
  return Effect.gen(function* () {
    const leaf = input.segments.at(-1);
    if (!leaf || leaf === ".") {
      return yield* pathError(input.context, input.operation, "path must include a final entry");
    }
    const realParent = yield* resolveParent({
      context: input.context,
      operation: input.operation,
      realRoot: input.realRoot,
      parentSegments: input.segments.slice(0, -1),
      create: input.createParent,
    });
    return { realParent, leaf };
  });
}

function ensureNoSymlinkLeaf(input: {
  readonly context: FilesystemPathContext;
  readonly operation: FilesystemOperation;
  readonly target: string;
}): Effect.Effect<void, FilesystemError> {
  return Effect.gen(function* () {
    const lstat = yield* lstatOrNull(
      input.target,
      input.context,
      input.operation,
      "failed to inspect target",
    );
    if (lstat?.isSymbolicLink()) {
      return yield* pathError(input.context, input.operation, "symlink leaf is not allowed", {
        resolvedPath: input.target,
      });
    }
  });
}

function openNoFollow(input: {
  readonly context: FilesystemPathContext;
  readonly operation: FilesystemOperation;
  readonly target: string;
  readonly flags: number;
}): Effect.Effect<NodeFSP.FileHandle, FilesystemError> {
  return Effect.tryPromise({
    try: () => NodeFSP.open(input.target, input.flags | NodeFS.constants.O_NOFOLLOW, 0o666),
    catch: (cause) =>
      isNodeSymlinkLoop(cause)
        ? pathError(input.context, input.operation, "symlink leaf is not allowed", {
            resolvedPath: input.target,
            cause,
          })
        : ioError(input.context, input.operation, "failed to open file", {
            resolvedPath: input.target,
            cause,
          }),
  });
}

function closeHandle(handle: NodeFSP.FileHandle) {
  return Effect.promise(() => handle.close()).pipe(Effect.ignore);
}

function readBytesFromHandle(input: {
  readonly handle: NodeFSP.FileHandle;
  readonly maxBytes: number;
  readonly failOnOverflow: boolean;
  readonly context: FilesystemPathContext;
  readonly operation: FilesystemOperation;
}): Effect.Effect<Uint8Array, FilesystemError> {
  return Effect.gen(function* () {
    const chunks: Buffer[] = [];
    let total = 0;
    const readLimit = input.failOnOverflow ? input.maxBytes + 1 : input.maxBytes;
    while (total < readLimit) {
      const buffer = Buffer.alloc(Math.min(READ_CHUNK_BYTES, readLimit - total));
      const result = yield* Effect.tryPromise({
        try: () => input.handle.read(buffer, 0, buffer.byteLength, null),
        catch: (cause) => ioError(input.context, input.operation, "failed to read file", { cause }),
      });
      if (result.bytesRead === 0) break;
      chunks.push(buffer.subarray(0, result.bytesRead));
      total += result.bytesRead;
    }
    if (input.failOnOverflow && total > input.maxBytes) {
      return yield* ioError(input.context, input.operation, "file exceeds the size limit", {
        limit: input.maxBytes,
        actual: total,
      });
    }
    return new Uint8Array(Buffer.concat(chunks, total));
  });
}

function readExistingFile(input: {
  readonly context: FilesystemPathContext;
  readonly operation: FilesystemOperation;
  readonly realPath: string;
  readonly maxBytes: number;
  readonly failOnOverflow: boolean;
}): Effect.Effect<Uint8Array, FilesystemError> {
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => NodeFSP.open(input.realPath, NodeFS.constants.O_RDONLY),
      catch: (cause) =>
        ioError(input.context, input.operation, "failed to open file", {
          resolvedPath: input.realPath,
          cause,
        }),
    }),
    (handle) =>
      Effect.gen(function* () {
        const stat = yield* Effect.tryPromise({
          try: () => handle.stat(),
          catch: (cause) =>
            ioError(input.context, input.operation, "failed to stat file", {
              resolvedPath: input.realPath,
              cause,
            }),
        });
        if (!stat.isFile()) {
          return yield* ioError(input.context, input.operation, "path is not a file", {
            resolvedPath: input.realPath,
          });
        }
        return yield* readBytesFromHandle({ ...input, handle });
      }),
    closeHandle,
  );
}

function writeBytesToTarget(input: {
  readonly context: FilesystemPathContext;
  readonly operation: FilesystemOperation;
  readonly target: string;
  readonly contents: Uint8Array;
  readonly exclusive: boolean;
}): Effect.Effect<void, FilesystemError> {
  return Effect.gen(function* () {
    if (input.contents.byteLength > FILE_MAX_BYTES) {
      return yield* ioError(input.context, input.operation, "file exceeds the size limit", {
        limit: FILE_MAX_BYTES,
        actual: input.contents.byteLength,
      });
    }
    yield* ensureNoSymlinkLeaf(input);
    const flags =
      NodeFS.constants.O_WRONLY |
      NodeFS.constants.O_CREAT |
      (input.exclusive ? NodeFS.constants.O_EXCL : NodeFS.constants.O_TRUNC);
    yield* Effect.acquireUseRelease(
      openNoFollow({ ...input, flags }),
      (handle) =>
        Effect.tryPromise({
          try: () => handle.writeFile(input.contents),
          catch: (cause) =>
            ioError(input.context, input.operation, "failed to write file", {
              resolvedPath: input.target,
              cause,
            }),
        }),
      closeHandle,
    );
  });
}

function dirEntryFor(input: {
  readonly context: FilesystemPathContext;
  readonly operation: FilesystemOperation;
  readonly realRoot: string;
  readonly absEntry: string;
  readonly relativePath: string;
  readonly name: string;
}): Effect.Effect<DirEntry | null, FilesystemError> {
  return Effect.gen(function* () {
    // Skip an entry only for failures that are PROPERTIES OF THE ENTRY: it vanished
    // between readdir and here (ENOENT — a listing race) or it is a symlink loop
    // (ELOOP — nothing real to list). Everything else — EACCES, EIO — used to be
    // swallowed too (`orElseSucceed(null)`), which made listDir/listDirRecursive
    // silently return an INCOMPLETE listing as if it had succeeded. Not being able
    // to read an entry is the caller's business; the entry not existing is not.
    const skippable = (cause: unknown): boolean =>
      isNodeNotFound(cause) || isNodeSymlinkLoop(cause);
    const realEntry = yield* Effect.tryPromise({
      // `null` in the failure channel means "skip this entry"; a FilesystemError
      // means the LISTING failed and the caller must know.
      catch: (cause) =>
        skippable(cause)
          ? null
          : ioError(input.context, input.operation, "failed to resolve directory entry", {
              resolvedPath: input.absEntry,
              cause,
            }),
      try: () => NodeFSP.realpath(input.absEntry),
    }).pipe(
      Effect.catch((failure) => (failure === null ? Effect.succeed(null) : Effect.fail(failure))),
    );
    if (realEntry === null || !containsRealPath(input.realRoot, realEntry)) {
      return null;
    }
    const stat = yield* Effect.tryPromise({
      catch: (cause) =>
        skippable(cause)
          ? null
          : ioError(input.context, input.operation, "failed to stat directory entry", {
              resolvedPath: realEntry,
              cause,
            }),
      try: () => NodeFSP.stat(realEntry),
    }).pipe(
      Effect.catch((failure) => (failure === null ? Effect.succeed(null) : Effect.fail(failure))),
    );
    if (stat === null) return null;
    return {
      name: input.name,
      relativePath: input.relativePath,
      type: statType(stat),
    };
  });
}

function makeCapability(input: {
  readonly snapshots: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
  readonly grants: PluginWorkspaceGrants;
}): FilesystemCapability {
  const prepare = (context: FilesystemPathContext, operation: FilesystemOperation) =>
    Effect.gen(function* () {
      const segments = yield* parseRelativePath(context, operation);
      const root = yield* requireRoot({ ...input, context, operation });
      return { ...root, segments };
    });

  const writeFileBytes = (
    context: FilesystemPathContext,
    contents: Uint8Array,
    exclusive: boolean,
    operation: "write-file" | "create-file-exclusive",
  ) =>
    Effect.gen(function* () {
      const { realRoot, segments } = yield* prepare(context, operation);
      const { realParent, leaf } = yield* resolveLeafParent({
        context,
        operation,
        realRoot,
        segments,
        createParent: true,
      });
      yield* writeBytesToTarget({
        context,
        operation,
        target: NodePath.join(realParent, leaf),
        contents,
        exclusive,
      });
    });

  const removePath = (
    context: FilesystemPathContext,
    realRoot: string,
    absPath: string,
    operation: FilesystemOperation,
  ): Effect.Effect<void, FilesystemError> =>
    Effect.gen(function* () {
      const lstat = yield* lstatOrNull(absPath, context, operation, "failed to inspect path");
      if (lstat === null) return;
      if (lstat.isSymbolicLink()) {
        yield* Effect.tryPromise({
          try: () => NodeFSP.unlink(absPath),
          catch: (cause) =>
            ioError(context, operation, "failed to remove symlink", {
              resolvedPath: absPath,
              cause,
            }),
        });
        return;
      }
      const realPath = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(absPath),
        catch: (cause) =>
          ioError(context, operation, "failed to resolve path", { resolvedPath: absPath, cause }),
      });
      if (!containsRealPath(realRoot, realPath)) {
        // No `data`: the resolved path is an out-of-root host path and must
        // not leak through plugin-visible error payloads.
        return yield* pathError(context, operation, "path resolves outside root");
      }
      if (lstat.isDirectory()) {
        const entries = yield* Effect.tryPromise({
          try: () => NodeFSP.readdir(absPath),
          catch: (cause) =>
            ioError(context, operation, "failed to read directory", {
              resolvedPath: absPath,
              cause,
            }),
        });
        for (const entry of entries) {
          yield* removePath(context, realRoot, NodePath.join(absPath, entry), operation);
        }
        yield* Effect.tryPromise({
          try: () => NodeFSP.rmdir(absPath),
          catch: (cause) =>
            ioError(context, operation, "failed to remove directory", {
              resolvedPath: absPath,
              cause,
            }),
        });
        return;
      }
      yield* Effect.tryPromise({
        try: () => NodeFSP.unlink(absPath),
        catch: (cause) =>
          ioError(context, operation, "failed to remove file", { resolvedPath: absPath, cause }),
      });
    });

  const readFile: FilesystemCapability["readFile"] = (context) =>
    Effect.gen(function* () {
      const operation = "read-file" as const;
      const { realRoot, segments } = yield* prepare(context, operation);
      const realPath = yield* realpathExistingTarget({ context, operation, realRoot, segments });
      return yield* readExistingFile({
        context,
        operation,
        realPath,
        maxBytes: FILE_MAX_BYTES,
        failOnOverflow: true,
      });
    });

  return {
    listRoots: () =>
      snapshotGrantedRoots(input).pipe(
        Effect.map((roots) => [...roots].sort((left, right) => left.localeCompare(right))),
        Effect.mapError((cause) =>
          ioError({ root: "", relativePath: "" }, "list-roots", "failed to read roots", {
            cause,
          }),
        ),
      ),
    readFile,
    readFileString: (context) =>
      readFile(context).pipe(Effect.map((bytes) => new TextDecoder().decode(bytes))),
    readFileStringCapped: (context) =>
      Effect.gen(function* () {
        const operation = "read-file-string-capped" as const;
        const { realRoot, segments } = yield* prepare(context, operation);
        const realPath = yield* realpathExistingTarget({ context, operation, realRoot, segments });
        // NaN would otherwise poison the read-loop bound (`total < NaN` is
        // always false); coerce it to 0 explicitly. +/-Infinity are already
        // handled by the clamp below.
        const requestedMaxBytes = Number.isNaN(context.maxBytes) ? 0 : context.maxBytes;
        const maxBytes = Math.max(0, Math.min(Math.floor(requestedMaxBytes), FILE_MAX_BYTES));
        const bytes = yield* readExistingFile({
          context,
          operation,
          realPath,
          maxBytes,
          failOnOverflow: false,
        });
        return new TextDecoder().decode(bytes);
      }),
    writeFile: (request) => writeFileBytes(request, request.contents, false, "write-file"),
    writeFileString: (request) =>
      writeFileBytes(request, new TextEncoder().encode(request.contents), false, "write-file"),
    createFileExclusive: (request) =>
      writeFileBytes(
        request,
        typeof request.contents === "string"
          ? new TextEncoder().encode(request.contents)
          : request.contents,
        true,
        "create-file-exclusive",
      ),
    exists: (context) =>
      Effect.gen(function* () {
        const operation = "exists" as const;
        const { realRoot, segments } = yield* prepare(context, operation);
        const logicalTarget = NodePath.join(context.root, ...segments);
        const lstat = yield* lstatOrNull(
          logicalTarget,
          context,
          operation,
          "failed to inspect path",
        );
        if (lstat === null) return false;
        // A dangling symlink (or a target removed mid-check) realpaths to
        // ENOENT: report plain non-existence instead of failing. An
        // out-of-root symlink target likewise reads as absent — `exists`
        // must not confirm that a host path outside the root exists.
        const realPath = yield* Effect.tryPromise({
          try: () => NodeFSP.realpath(logicalTarget),
          catch: (cause) =>
            isNodeNotFound(cause)
              ? new NodePathNotFound()
              : ioError(context, operation, "failed to resolve path", {
                  resolvedPath: logicalTarget,
                  cause,
                }),
        }).pipe(
          Effect.catch((error) =>
            error instanceof NodePathNotFound ? Effect.succeed(null) : Effect.fail(error),
          ),
        );
        if (realPath === null) return false;
        return containsRealPath(realRoot, realPath);
      }),
    stat: (context) =>
      Effect.gen(function* () {
        const operation = "stat" as const;
        const { realRoot, segments } = yield* prepare(context, operation);
        const realPath = yield* realpathExistingTarget({ context, operation, realRoot, segments });
        const stat = yield* Effect.tryPromise({
          try: () => NodeFSP.stat(realPath),
          catch: (cause) =>
            ioError(context, operation, "failed to stat path", { resolvedPath: realPath, cause }),
        });
        return {
          type: statType(stat),
          size: stat.size,
          mtime: stat.mtimeMs,
          realPath,
        };
      }),
    listDir: (context) =>
      Effect.gen(function* () {
        const operation = "list-dir" as const;
        const { realRoot, segments } = yield* prepare(context, operation);
        const realPath = yield* realpathExistingTarget({ context, operation, realRoot, segments });
        const stat = yield* Effect.tryPromise({
          try: () => NodeFSP.stat(realPath),
          catch: (cause) =>
            ioError(context, operation, "failed to stat directory", {
              resolvedPath: realPath,
              cause,
            }),
        });
        if (!stat.isDirectory()) {
          return yield* ioError(context, operation, "path is not a directory", {
            resolvedPath: realPath,
          });
        }
        const entries = yield* Effect.tryPromise({
          try: () => NodeFSP.readdir(realPath),
          catch: (cause) =>
            ioError(context, operation, "failed to read directory", {
              resolvedPath: realPath,
              cause,
            }),
        });
        const results: DirEntry[] = [];
        for (const name of entries.sort((left, right) => left.localeCompare(right))) {
          const entry = yield* dirEntryFor({
            context,
            operation,
            realRoot,
            absEntry: NodePath.join(realPath, name),
            relativePath: outputRelativePath(context.relativePath, name),
            name,
          });
          if (entry) results.push(entry);
        }
        return results;
      }),
    listDirRecursive: (context) =>
      Effect.gen(function* () {
        const operation = "list-dir-recursive" as const;
        const { realRoot, segments } = yield* prepare(context, operation);
        const realPath = yield* realpathExistingTarget({ context, operation, realRoot, segments });
        const results: DirEntry[] = [];
        // Real paths already walked. dirEntryFor classifies through realpath/stat —
        // which FOLLOW symlinks — so a link to its own directory or an ancestor is
        // reported as a directory and the walk descended into it again. The entry cap
        // stopped it from running forever, which made it worse: instead of hanging,
        // it returned thousands of duplicate entries for the cycle and called that a
        // listing. Each real directory is walked once.
        const visited = new Set<string>();
        const walk = (absDir: string, relativeDir: string): Effect.Effect<void, FilesystemError> =>
          Effect.gen(function* () {
            if (results.length >= LIST_RECURSIVE_MAX_ENTRIES) return;
            const entries = yield* Effect.tryPromise({
              try: () => NodeFSP.readdir(absDir),
              catch: (cause) =>
                ioError(context, operation, "failed to read directory", {
                  resolvedPath: absDir,
                  cause,
                }),
            });
            for (const name of entries.sort((left, right) => left.localeCompare(right))) {
              if (results.length >= LIST_RECURSIVE_MAX_ENTRIES) return;
              const relPath = outputRelativePath(relativeDir, name);
              const entry = yield* dirEntryFor({
                context,
                operation,
                realRoot,
                absEntry: NodePath.join(absDir, name),
                relativePath: relPath,
                name,
              });
              if (!entry) continue;
              results.push(entry);
              if (entry.type === "directory") {
                const childRealPath = yield* realpathExistingTarget({
                  context,
                  operation,
                  realRoot,
                  segments: relPath.split("/").filter(Boolean),
                });
                if (visited.has(childRealPath)) continue;
                visited.add(childRealPath);
                yield* walk(childRealPath, relPath);
              }
            }
          });
        visited.add(realPath);
        yield* walk(realPath, context.relativePath);
        return results;
      }),
    makeDirectory: (context) =>
      Effect.gen(function* () {
        const operation = "make-directory" as const;
        const { realRoot, segments } = yield* prepare(context, operation);
        yield* resolveParent({
          context,
          operation,
          realRoot,
          parentSegments: segments,
          create: true,
        });
      }),
    remove: (context) =>
      Effect.gen(function* () {
        const operation = "remove" as const;
        const { realRoot, segments } = yield* prepare(context, operation);
        const { realParent, leaf } = yield* resolveLeafParent({
          context,
          operation,
          realRoot,
          segments,
          createParent: false,
        }).pipe(
          Effect.catch((error) =>
            isFilesystemIoError(error) && error.reason === "parent path does not exist"
              ? Effect.succeed({ realParent: "", leaf: "" })
              : Effect.fail(error),
          ),
        );
        if (!leaf) return;
        yield* removePath(context, realRoot, NodePath.join(realParent, leaf), operation);
      }),
    rename: (request) =>
      Effect.gen(function* () {
        const operation = "rename" as const;
        const fromContext = { root: request.root, relativePath: request.fromRelativePath };
        const toContext = { root: request.root, relativePath: request.toRelativePath };
        const { realRoot, segments: fromSegments } = yield* prepare(fromContext, operation);
        const toSegments = yield* parseRelativePath(toContext, operation);
        const from = yield* resolveLeafParent({
          context: fromContext,
          operation,
          realRoot,
          segments: fromSegments,
          createParent: false,
        });
        const to = yield* resolveLeafParent({
          context: toContext,
          operation,
          realRoot,
          segments: toSegments,
          createParent: false,
        });
        const fromAbs = NodePath.join(from.realParent, from.leaf);
        const toAbs = NodePath.join(to.realParent, to.leaf);
        const fromLstat = yield* Effect.tryPromise({
          try: () => NodeFSP.lstat(fromAbs),
          catch: (cause) =>
            ioError(fromContext, operation, "failed to inspect source", {
              resolvedPath: fromAbs,
              cause,
            }),
        });
        if (!fromLstat.isSymbolicLink()) {
          const fromReal = yield* Effect.tryPromise({
            try: () => NodeFSP.realpath(fromAbs),
            catch: (cause) =>
              ioError(fromContext, operation, "failed to resolve source", {
                resolvedPath: fromAbs,
                cause,
              }),
          });
          if (!containsRealPath(realRoot, fromReal)) {
            // No `data`: the resolved source is an out-of-root host path and
            // must not leak through plugin-visible error payloads.
            return yield* pathError(fromContext, operation, "source resolves outside root");
          }
        }
        // Reject an existing destination unless the caller explicitly opts into
        // atomic replace (e.g. writeFileAtomic renaming a temp file over an
        // already-present target). NodeFSP.rename performs the replace atomically
        // on POSIX and Windows; the destination stays inside the granted root
        // (its parent was resolved above), and rename swaps the directory entry
        // rather than following a symlink's target, so this cannot escape the root.
        //
        // KNOWN LIMITATION (full-trust TOCTOU): this no-overwrite guard is
        // check-then-act — a destination created between the lstat below and
        // the rename gets silently replaced. Node exposes no
        // renameat2(RENAME_NOREPLACE)/renamex_np(RENAME_EXCL), so a truly
        // atomic no-replace rename is not available; accepted under the
        // full-trust model (the race requires a concurrent local writer, and
        // the replace still cannot escape the granted root).
        if (!request.overwrite) {
          const toExists =
            (yield* lstatOrNull(toAbs, toContext, operation, "failed to inspect destination")) !==
            null;
          if (toExists) {
            return yield* ioError(toContext, operation, "destination already exists", {
              resolvedPath: toAbs,
            });
          }
        }
        yield* Effect.tryPromise({
          try: () => NodeFSP.rename(fromAbs, toAbs),
          catch: (cause) =>
            ioError(fromContext, operation, "failed to rename path", {
              fromResolvedPath: fromAbs,
              toResolvedPath: toAbs,
              cause,
            }),
        });
      }),
  };
}

export const makeFilesystemCapability = makeCapability;
