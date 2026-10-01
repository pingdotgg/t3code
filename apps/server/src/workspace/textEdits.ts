// @effect-diagnostics nodeBuiltinImport:off
/**
 * Safe serialized read/replace boundary for the editable-text checkpoint.
 *
 * This is deliberately NOT WorkspaceFileSystem.writeFile: that path is
 * lexical-only, truncates in place, and has no revision or symlink checks.
 * Here every operation walks the lexical path component by component with
 * lstat, rejecting any symlinked component, non-directory ancestor, escape
 * from the real root, or non-regular target before any byte is read or
 * written. Saves verify the complete-byte SHA-256 revision under a
 * per-realpath lock and replace the file via an exclusively-created
 * same-directory temporary file and rename; on any failure only the captured
 * temporary path is unlinked.
 *
 * The lock serializes cooperating callers of this module only. A concurrent
 * rename by an unrelated process between our revision compare and our rename
 * can still win (compare/rename race), and the component walk is a best
 * effort, not containment against malicious concurrent directory
 * replacement; no universal compare-and-swap or sandbox guarantee is made.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { EDITABLE_TEXT_MAX_BYTES } from "@t3tools/extension-sdk/catalogue";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";

import { WorkspacePaths } from "./WorkspacePaths.ts";

export type TextEditsIoReason =
  | "not-found"
  | "not-regular-file"
  | "binary"
  | "invalid-utf8"
  | "oversized"
  | "outside-workspace"
  | "unsafe-path"
  | "changed-during-read"
  | "aborted"
  | "io-error";

export class TextEditsError extends Data.TaggedError("TextEditsError")<{
  readonly reason: TextEditsIoReason;
}> {
  override get message(): string {
    return `Editable text operation failed: ${this.reason}`;
  }
  static of(reason: TextEditsIoReason): TextEditsError {
    return new TextEditsError({ reason });
  }
}

/** Structural check: a thrown beforeCommit rejection carrying a reason. */
const isTextEditsError = (cause: unknown): cause is TextEditsError =>
  typeof cause === "object" &&
  cause !== null &&
  (cause as { readonly _tag?: unknown })._tag === "TextEditsError" &&
  typeof (cause as { readonly reason?: unknown }).reason === "string";

export interface TextEditsFileSystem {
  readonly realpath: (path: string) => Promise<string>;
  readonly lstat: (path: string) => Promise<NodeFS.Stats>;
  readonly open: typeof NodeFSP.open;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly unlink: (path: string) => Promise<void>;
  readonly chmod: (path: string, mode: number) => Promise<void>;
}

export const nodeTextEditsFileSystem: TextEditsFileSystem = {
  realpath: (path) => NodeFSP.realpath(path),
  lstat: (path) => NodeFSP.lstat(path),
  open: NodeFSP.open,
  rename: (from, to) => NodeFSP.rename(from, to),
  unlink: (path) => NodeFSP.unlink(path),
  chmod: (path, mode) => NodeFSP.chmod(path, mode),
};

const sha256Hex = (bytes: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

export type SafeResolvedTarget = {
  /** Symlink-free real directory containing the target file itself. */
  readonly realDirectory: string;
  /** Final component of the requested path, never a path separator. */
  readonly fileName: string;
  /** Symlink-free real target path when the file exists; otherwise undefined. */
  readonly realTargetPath: string | undefined;
  /** Current mode bits when the target exists; otherwise undefined. */
  readonly existingMode: number | undefined;
};

/**
 * Rejects platform mappings this checkpoint cannot make symlink-safe rather
 * than silently degrading the checks below. The platform comes from the
 * injected HostProcessPlatform reference (the repo's injectable host seam),
 * so tests provide "win32" through the service instead of a global read.
 */
const platformFailure = Effect.map(HostProcessPlatform, (platform) =>
  platform === "win32" ? Effect.fail(TextEditsError.of("unsafe-path")) : Effect.void,
).pipe(Effect.flatten);

/**
 * Resolve the lexical path while rejecting every symlinked component. The
 * workspace root itself is realpathed first (it may legitimately be reached
 * through host-level links such as /tmp); every component below it is walked
 * with lstat and never followed through a link.
 */
export const resolveSafeTarget = Effect.fn("TextEdits.resolveSafeTarget")(function* (
  input: { readonly cwd: string; readonly relativePath: string },
  io: TextEditsFileSystem = nodeTextEditsFileSystem,
) {
  yield* platformFailure;
  const paths = yield* WorkspacePaths;
  const target = yield* paths
    .resolveRelativePathWithinRoot({ workspaceRoot: input.cwd, relativePath: input.relativePath })
    .pipe(Effect.mapError(() => TextEditsError.of("outside-workspace")));
  const fileName = NodePath.basename(target.absolutePath);
  if (fileName === "." || fileName === "..") return yield* TextEditsError.of("unsafe-path");
  const realRoot = yield* Effect.tryPromise({
    try: () => io.realpath(input.cwd),
    catch: () => TextEditsError.of("not-found"),
  });
  const rootStat = yield* Effect.tryPromise({
    try: () => io.lstat(realRoot),
    catch: () => TextEditsError.of("not-found"),
  });
  if (!rootStat.isDirectory()) return yield* TextEditsError.of("not-regular-file");
  let directory = realRoot;
  for (const part of target.relativePath.split("/").slice(0, -1)) {
    const next = NodePath.join(directory, part);
    const links = yield* Effect.tryPromise({
      try: () => io.lstat(next),
      catch: () => TextEditsError.of("not-found"),
    });
    if (links.isSymbolicLink()) return yield* TextEditsError.of("unsafe-path");
    if (!links.isDirectory()) return yield* TextEditsError.of("not-regular-file");
    directory = next;
  }
  let realTargetPath: string | undefined;
  let existingMode: number | undefined;
  const entry = yield* Effect.result(
    Effect.tryPromise({
      try: () => io.lstat(NodePath.join(directory, fileName)),
      catch: () => TextEditsError.of("not-found"),
    }),
  );
  if (entry._tag === "Success") {
    if (entry.success.isSymbolicLink()) return yield* TextEditsError.of("unsafe-path");
    if (!entry.success.isFile()) return yield* TextEditsError.of("not-regular-file");
    const candidate = NodePath.join(directory, fileName);
    const real = yield* Effect.tryPromise({
      try: () => io.realpath(candidate),
      catch: () => TextEditsError.of("unsafe-path"),
    });
    if (real !== candidate) return yield* TextEditsError.of("changed-during-read");
    realTargetPath = candidate;
    existingMode = entry.success.mode & 0o7777;
  }
  return { realDirectory: directory, fileName, realTargetPath, existingMode };
});

/**
 * Complete fatal UTF-8 decode; never substitutes replacement characters and
 * never strips a leading BOM: `ignoreBOM` keeps the U+FEFF character in the
 * decoded text so a snapshot decoded here re-encodes to the same EF BB BF
 * bytes on save. Returns undefined when the bytes are not valid UTF-8 (a
 * string sentinel would be indistinguishable from decoded text by `typeof`).
 */
export function decodeEditableUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

const readConsistent = Effect.fn("TextEdits.readConsistent")(function* (
  realPath: string,
  io: TextEditsFileSystem,
  maxBytes: number,
) {
  return yield* Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => io.open(realPath, NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NONBLOCK ?? 0)),
      catch: () => TextEditsError.of("io-error"),
    }),
    (opened) =>
      Effect.gen(function* () {
        const stat = yield* Effect.tryPromise({
          try: () => opened.stat(),
          catch: () => TextEditsError.of("io-error"),
        });
        if (!stat.isFile()) return yield* TextEditsError.of("not-regular-file");
        if (stat.size > maxBytes) return yield* TextEditsError.of("oversized");
        const buffer = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < stat.size) {
          const { bytesRead } = yield* Effect.tryPromise({
            try: () => opened.read(buffer, offset, stat.size - offset, offset),
            catch: () => TextEditsError.of("io-error"),
          });
          if (bytesRead <= 0) return yield* TextEditsError.of("changed-during-read");
          offset += bytesRead;
        }
        const after = yield* Effect.tryPromise({
          try: () => opened.stat(),
          catch: () => TextEditsError.of("io-error"),
        });
        if (after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
          return yield* TextEditsError.of("changed-during-read");
        return buffer;
      }),
    (opened) =>
      Effect.tryPromise({
        try: () => opened.close(),
        catch: () => TextEditsError.of("io-error"),
      }),
  );
});

export type ReadEditableOutcome =
  | { readonly outcome: "ok"; readonly bytes: Uint8Array; readonly revision: string }
  | { readonly outcome: "error"; readonly reason: TextEditsIoReason };

/**
 * Read the complete regular file at the resolved target with its revision
 * hash. Never returns truncated or torn data: oversized, binary, and invalid
 * UTF-8 inputs are explicit error outcomes, and an observed path or identity
 * change between resolution and read is rejected.
 */
export const readEditableFile = Effect.fn("TextEdits.readEditableFile")(function* (
  input: { readonly cwd: string; readonly relativePath: string },
  io: TextEditsFileSystem = nodeTextEditsFileSystem,
) {
  const attempt = yield* Effect.result(
    Effect.gen(function* () {
      const target = yield* resolveSafeTarget(input, io);
      if (target.realTargetPath === undefined) return yield* TextEditsError.of("not-found");
      const bytes = yield* readConsistent(target.realTargetPath, io, EDITABLE_TEXT_MAX_BYTES);
      if (bytes.includes(0)) return yield* TextEditsError.of("binary");
      const contents = decodeEditableUtf8(bytes);
      if (contents === undefined) return yield* TextEditsError.of("invalid-utf8");
      const after = yield* resolveSafeTarget(input, io);
      if (
        after.realTargetPath !== target.realTargetPath ||
        after.existingMode !== target.existingMode
      )
        return yield* TextEditsError.of("changed-during-read");
      return {
        outcome: "ok" as const,
        bytes: new Uint8Array(bytes),
        revision: sha256Hex(bytes),
      };
    }),
  );
  if (Result.isFailure(attempt))
    return { outcome: "error" as const, reason: attempt.failure.reason };
  return attempt.success;
});

/**
 * FIFO mutex over resolved real paths for cooperating writers. Entries are
 * removed as soon as the current holder releases and no waiter is chained
 * behind it, so idle paths do not accumulate; a second save queued behind an
 * active one still serializes behind the same chain.
 */
const mutexes = new Map<string, Promise<void>>();
export const idleMutexKeys = (): string[] => [...mutexes.keys()];
const acquireResource = (key: string): Promise<() => void> => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = mutexes.get(key) ?? Promise.resolve();
  // Tail kept in the map for later arrivals; resolved when this holder
  // releases. Drop the entry once drained so idle paths do not accumulate.
  const tail = previous.then(() => gate);
  mutexes.set(key, tail);
  void tail
    .catch(() => {})
    .then(() => {
      if (mutexes.get(key) === tail) mutexes.delete(key);
    });
  void previous.catch(() => {});
  return previous.then(() => release);
};

export type ReplaceOutcome =
  | { readonly outcome: "saved"; readonly revision: string }
  | { readonly outcome: "conflict" }
  | { readonly outcome: "error"; readonly reason: TextEditsIoReason };

/**
 * Serialized compare-and-replace. Re-resolves the target under the
 * per-realpath lock, verifies the complete-byte SHA-256 revision, then writes
 * an O_EXCL temporary file in the same directory, preserves the previous
 * mode, and renames over the target. Just before the rename — still inside
 * the lock, with the temp file written, fsynced, and closed — the optional
 * `beforeCommit` callback is awaited and `shouldAbort` is checked one final
 * time: a revocation, scope move, or cancellation that lands there aborts
 * with the temporary file discarded and the original bytes untouched.
 *
 * The temporary file and its open handle are owned by an Effect
 * acquire/release bracket: the release effect closes the handle if it is
 * still open and unlinks the captured temporary path, and it runs on EVERY
 * exit — success, failure, or real fiber interruption (a live AbortSignal
 * tearing down the awaiting fiber). The release effect is awaited before the
 * operation's own outcome is produced, so by the time the awaiting caller
 * observes rejection the temporary file is already gone. An abort after the
 * rename has landed is the caller's outcome-unknown case; the rename itself
 * is never pretended cancellable.
 */
export const replaceEditableFile = Effect.fn("TextEdits.replaceEditableFile")(function* (
  input: {
    readonly cwd: string;
    readonly relativePath: string;
    readonly expectedRevision: string;
    readonly contents: string;
    /**
     * Byte bound for the current-bytes consistency read and the new contents.
     * The editable checkpoint passes nothing and gets EDITABLE_TEXT_MAX_BYTES;
     * `t3.workspace/resources` save commits pass the transfer contract's bound.
     */
    readonly maxBytes?: number;
    readonly shouldAbort?: () => boolean;
    readonly beforeCommit?: () => Promise<void>;
  },
  io: TextEditsFileSystem = nodeTextEditsFileSystem,
) {
  const maxBytes = input.maxBytes ?? EDITABLE_TEXT_MAX_BYTES;
  const whole = Effect.gen(function* () {
    const preliminary = yield* resolveSafeTarget(
      { cwd: input.cwd, relativePath: input.relativePath },
      io,
    );
    const lockKey =
      preliminary.realTargetPath ?? NodePath.join(preliminary.realDirectory, preliminary.fileName);
    return yield* Effect.acquireUseRelease(
      Effect.promise(() => acquireResource(lockKey)),
      () =>
        Effect.gen(function* () {
          const target = yield* resolveSafeTarget(
            { cwd: input.cwd, relativePath: input.relativePath },
            io,
          );
          if (
            target.realDirectory !== preliminary.realDirectory ||
            target.realTargetPath !== preliminary.realTargetPath ||
            target.existingMode !== preliminary.existingMode
          )
            return yield* TextEditsError.of("changed-during-read");
          if (target.realTargetPath === undefined) return yield* TextEditsError.of("not-found");
          const current = yield* readConsistent(target.realTargetPath, io, maxBytes);
          if (sha256Hex(current) !== input.expectedRevision)
            return { outcome: "conflict" as const };
          if (input.shouldAbort?.()) return yield* TextEditsError.of("aborted");
          const encoded = Buffer.from(input.contents, "utf8");
          if (encoded.length > maxBytes) return yield* TextEditsError.of("oversized");
          if (encoded.includes(0)) return yield* TextEditsError.of("binary");
          const temporaryPath = `${target.realTargetPath}.t3-edit-${NodeCrypto.randomBytes(8).toString("hex")}`;
          if (input.shouldAbort?.()) return yield* TextEditsError.of("aborted");
          // The temp file and its open handle are owned by an acquire/release
          // bracket whose acquisition is the O_EXCL open itself: acquisition
          // runs uninterruptibly, so an interruption landing while the open
          // is still in flight is DEFERRED until the create has completed and
          // the release finalizer is registered — there is no window in which
          // the path exists on disk without a finalizer owning it. The
          // release effect runs on EVERY exit — success, failure, or real
          // fiber interruption — is awaited uninterruptibly before the
          // operation's outcome is produced, and closes the handle if it is
          // still open, then unlinks the temp unless a confirmed rename
          // consumed it.
          let renamed = false;
          return yield* Effect.acquireUseRelease(
            Effect.tryPromise({
              try: () =>
                io.open(
                  temporaryPath,
                  NodeFS.constants.O_WRONLY | NodeFS.constants.O_CREAT | NodeFS.constants.O_EXCL,
                  target.existingMode ?? 0o644,
                ),
              catch: () => TextEditsError.of("io-error"),
            }),
            (opened) =>
              Effect.gen(function* () {
                const written = yield* Effect.tryPromise({
                  try: async () => {
                    await opened.writeFile(encoded);
                    await opened.sync();
                    await opened.close();
                  },
                  catch: () => TextEditsError.of("io-error"),
                }).pipe(Effect.result);
                if (Result.isFailure(written)) {
                  return yield* written.failure;
                }
                if (target.existingMode !== undefined) {
                  const kept = yield* Effect.tryPromise({
                    try: () => io.chmod(temporaryPath, target.existingMode!),
                    catch: () => TextEditsError.of("io-error"),
                  }).pipe(Effect.result);
                  if (Result.isFailure(kept)) {
                    return yield* kept.failure;
                  }
                }
                // Publication barrier: still under the lock, temp fully
                // written. A rejected beforeCommit (revoked authority, moved
                // scope) or an abort that landed during the async check
                // discards the temp file and keeps the original bytes.
                const barrier = yield* Effect.tryPromise({
                  try: async () => {
                    await input.beforeCommit?.();
                    if (input.shouldAbort?.()) throw TextEditsError.of("aborted");
                  },
                  catch: (cause) =>
                    isTextEditsError(cause) ? cause : TextEditsError.of("aborted"),
                }).pipe(Effect.result);
                if (Result.isFailure(barrier)) {
                  return yield* barrier.failure;
                }
                const renamedOk = yield* Effect.tryPromise({
                  try: () => io.rename(temporaryPath, target.realTargetPath!),
                  catch: () => TextEditsError.of("io-error"),
                }).pipe(Effect.result);
                if (Result.isFailure(renamedOk)) {
                  return yield* renamedOk.failure;
                }
                // Only a confirmed rename suppresses the finalizer's unlink;
                // every other exit (including an interruption landing during
                // the rename await) leaves renamed=false, and unlinking a
                // temp the rename already consumed fails with ENOENT and is
                // swallowed — never touching the original file.
                renamed = true;
                return { outcome: "saved" as const, revision: sha256Hex(encoded) } as const;
              }),
            (opened) =>
              // Finalizer for EVERY exit, awaited uninterruptibly before the
              // operation's outcome is produced: close the handle if `use`
              // has not already (a second close rejects and is swallowed),
              // then unlink the temp unless the rename consumed it.
              Effect.tryPromise({
                try: async () => {
                  await opened.close().catch(() => {});
                  if (!renamed) await io.unlink(temporaryPath).catch(() => {});
                },
                catch: () => TextEditsError.of("io-error"),
              }).pipe(Effect.ignore),
          );
        }),
      (release) => Effect.sync(() => release()),
    );
  });
  // Interruption-honest capture: an aborted fiber's cause carries no error
  // channel value, so the aborted reason is synthesized from the live abort
  // flag instead of being read off a Result that was never produced. The
  // temp-file finalizer above has already run by the time this wrapper sees
  // the exit — its unlink is awaited inside the interrupted fiber.
  const attempt = yield* Effect.exit(whole);
  if (Exit.isSuccess(attempt)) return attempt.value;
  if (attempt.cause.reasons.some(Cause.isInterruptReason)) {
    if (input.shouldAbort?.()) return { outcome: "error" as const, reason: "aborted" };
    return yield* Effect.interrupt;
  }
  const failure = attempt.cause.reasons.find(Cause.isFailReason);
  if (failure) return { outcome: "error" as const, reason: failure.error.reason };
  const defect = attempt.cause.reasons.find(Cause.isDieReason);
  return yield* Effect.die(defect?.defect ?? TextEditsError.of("aborted"));
});
