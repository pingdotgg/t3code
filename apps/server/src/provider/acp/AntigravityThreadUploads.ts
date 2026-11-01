// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class AntigravityThreadUploadsError extends Schema.TaggedError<AntigravityThreadUploadsError>()(
  "AntigravityThreadUploadsError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

const ROOT_SEGMENTS = ["antigravity", "thread-uploads"] as const;

function rootSegments(threadId: ThreadId) {
  // The attachment id's thread segment is lowercased and truncated, so only the full id proves ownership.
  const digest = NodeCrypto.createHash("sha256").update(threadId).digest("hex").slice(0, 32);
  return [...ROOT_SEGMENTS, digest];
}

/** Each thread's agent reads uploads from its own flat directory of private copies. */
export function antigravityThreadUploadsRoot(stateDir: string, threadId: ThreadId): string {
  return NodePath.join(stateDir, ...rootSegments(threadId));
}

export function antigravityThreadUploadPath(root: string, storedPath: string): string {
  return NodePath.join(root, NodePath.basename(storedPath));
}

/** Creates each managed level as a real directory; a link anywhere would redirect writes and pruning. */
async function ensureManagedRoot(stateDir: string, threadId: ThreadId) {
  const base = await NodeFS.promises.realpath(stateDir);
  let current = base;
  let created = false;
  for (const segment of rootSegments(threadId)) {
    current = NodePath.join(current, segment);
    created = await NodeFS.promises.mkdir(current, { mode: 0o700 }).then(
      () => true,
      (cause: NodeJS.ErrnoException) => {
        if (cause.code !== "EEXIST") throw cause;
        return false;
      },
    );
    const info = await NodeFS.promises.lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Managed upload directory '${current}' is not a plain directory.`);
    }
  }
  if ((await NodeFS.promises.realpath(current)) !== current) {
    throw new Error(`Managed upload directory '${current}' resolves elsewhere.`);
  }
  return { root: current, created };
}

const MOVED_UPLOADS_MARKER = ".moved-uploads-notice";
const MOVED_NOTICE_FILES = 8;
const MOVED_NOTICE_PATH_BYTES = 2 * 1024;

export interface AntigravityMovedUploads {
  /** The canonical root, the path the agent was granted. */
  readonly root: string;
  /** Newest first, bounded; never sidecars or files outside the thread's history. */
  readonly files: ReadonlyArray<string>;
  readonly more: number;
}

/**
 * Native history from before thread roots names uploads at their stored paths, which the agent
 * now refuses. Records which of the thread's files moved, so the next prompt names them once.
 */
export const markAntigravityMovedUploads = Effect.fn("markAntigravityMovedUploads")(function* (
  root: string,
  storedPaths: ReadonlyArray<string>,
) {
  const names = [...new Set(storedPaths.map((stored) => NodePath.basename(stored)))];
  yield* Effect.tryPromise(() =>
    NodeFS.promises.writeFile(NodePath.join(root, MOVED_UPLOADS_MARKER), names.join("\n"), {
      flag: "wx",
    }),
  ).pipe(Effect.ignore);
});

/** Once per mark. Lists only files still present in the root, newest first. */
export const takeAntigravityMovedUploads = Effect.fn("takeAntigravityMovedUploads")(function* (
  root: string,
) {
  return yield* Effect.tryPromise(async (): Promise<AntigravityMovedUploads> => {
    const marker = NodePath.join(root, MOVED_UPLOADS_MARKER);
    const contents = await NodeFS.promises.readFile(marker, "utf8");
    await NodeFS.promises.unlink(marker);
    const canonical = await NodeFS.promises.realpath(root);
    // Stored attachment names are an id and an extension, one per line.
    const names = contents.split("\n").filter(Boolean);
    const present: Array<string> = [];
    for (const name of names.toReversed()) {
      if (name !== NodePath.basename(name) || name.startsWith(".")) continue;
      const info = await NodeFS.promises
        .lstat(NodePath.join(canonical, name))
        .catch(() => undefined);
      if (info?.isFile() === true) present.push(NodePath.join(canonical, name));
    }
    const files: Array<string> = [];
    let bytes = 0;
    for (const file of present) {
      bytes += Buffer.byteLength(file);
      if (files.length === MOVED_NOTICE_FILES || bytes > MOVED_NOTICE_PATH_BYTES) break;
      files.push(file);
    }
    return { root: canonical, files, more: present.length - files.length };
  }).pipe(Effect.orElseSucceed(() => undefined));
});

/**
 * Removes a deleted thread's copies. Idempotent; a missing level means nothing to do, and a
 * linked level fails closed. Only flat entries are unlinked, so nothing outside is reached.
 */
export const removeAntigravityThreadUploads = Effect.fn("removeAntigravityThreadUploads")(
  function* (input: { readonly stateDir: string; readonly threadId: ThreadId }) {
    yield* Effect.tryPromise({
      try: async () => {
        let root = await NodeFS.promises.realpath(input.stateDir);
        for (const segment of rootSegments(input.threadId)) {
          root = NodePath.join(root, segment);
          const info = await NodeFS.promises.lstat(root).catch((cause: NodeJS.ErrnoException) => {
            if (cause.code === "ENOENT") return undefined;
            throw cause;
          });
          if (info === undefined) return;
          if (!info.isDirectory() || info.isSymbolicLink()) {
            throw new Error(`Managed upload directory '${root}' is not a plain directory.`);
          }
        }
        for (const entry of await NodeFS.promises.readdir(root, { withFileTypes: true })) {
          if (entry.isDirectory()) continue;
          await NodeFS.promises
            .unlink(NodePath.join(root, entry.name))
            .catch((cause: NodeJS.ErrnoException) => {
              if (cause.code !== "ENOENT") throw cause;
            });
        }
        await NodeFS.promises.rmdir(root).catch((cause: NodeJS.ErrnoException) => {
          if (cause.code !== "ENOENT" && cause.code !== "ENOTEMPTY") throw cause;
        });
      },
      catch: (cause) =>
        new AntigravityThreadUploadsError({
          detail: "Could not remove this thread's Antigravity uploads.",
          cause,
        }),
    });
  },
);

/** A regular file directly in the store, never a link that could point at another thread's bytes. */
async function storedFile(store: string, source: string): Promise<NodeFS.Stats | undefined> {
  const info = await NodeFS.promises.lstat(source).catch(() => undefined);
  if (info === undefined || !info.isFile()) return undefined;
  const real = await NodeFS.promises.realpath(source);
  return NodePath.dirname(real) === store ? info : undefined;
}

// Copies carry the source's whole-second mtime, which every supported filesystem stores exactly.
// An agent edit to the copy moves it off that value, so the copy is refreshed.
const copyMtimeSeconds = (source: NodeFS.Stats) => Math.floor(source.mtimeMs / 1000);
const isCurrentCopy = (copy: NodeFS.Stats, source: NodeFS.Stats) =>
  copy.isFile() && copy.size === source.size && copy.mtimeMs === copyMtimeSeconds(source) * 1000;

async function copyPrivately(source: string, destination: string, info: NodeFS.Stats) {
  const temporary = NodePath.join(
    NodePath.dirname(destination),
    `.${NodePath.basename(destination)}.${NodeCrypto.randomUUID()}.tmp`,
  );
  try {
    // Copy-on-write where the filesystem supports it. A hardlink would let an edit reach the store.
    await NodeFS.promises.copyFile(source, temporary, NodeFS.constants.COPYFILE_FICLONE);
    const seconds = copyMtimeSeconds(info);
    await NodeFS.promises.utimes(temporary, seconds, seconds);
    await NodeFS.promises.rename(temporary, destination);
  } catch (cause) {
    await NodeFS.promises.rm(temporary, { force: true });
    throw cause;
  }
}

/**
 * Gives the thread's root private copies of the authorized `storedPaths` and their extracted-text
 * sidecars. With `prune`, other flat entries are removed, so uploads that left the thread's
 * history, or whose source is gone, stop being readable.
 */
export const syncAntigravityThreadUploads = Effect.fn("syncAntigravityThreadUploads")(
  function* (input: {
    readonly stateDir: string;
    readonly threadId: ThreadId;
    readonly attachmentsDir: string;
    readonly storedPaths: ReadonlyArray<string>;
    readonly prune: boolean;
  }) {
    return yield* Effect.tryPromise({
      try: async () => {
        const { root, created } = await ensureManagedRoot(input.stateDir, input.threadId);
        const store = await NodeFS.promises.realpath(input.attachmentsDir);
        const retained = new Set<string>();
        for (const stored of input.storedPaths) {
          for (const source of [stored, `${stored}.txt`]) {
            const info = await storedFile(store, source);
            if (info === undefined) continue;
            const name = NodePath.basename(source);
            retained.add(name);
            const destination = NodePath.join(root, name);
            const existing = await NodeFS.promises.lstat(destination).catch(() => undefined);
            if (existing !== undefined && isCurrentCopy(existing, info)) continue;
            if (existing !== undefined && existing.isDirectory()) {
              throw new Error(`Upload copy '${destination}' is a directory.`);
            }
            await copyPrivately(source, destination, info);
          }
        }
        if (!input.prune) return { root, created };
        for (const entry of await NodeFS.promises.readdir(root, { withFileTypes: true })) {
          // Dot files are another sync's in-flight copies. Directories are not ours to recurse into.
          if (retained.has(entry.name) || entry.name.startsWith(".") || entry.isDirectory())
            continue;
          await NodeFS.promises
            .unlink(NodePath.join(root, entry.name))
            .catch((cause: NodeJS.ErrnoException) => {
              if (cause.code !== "ENOENT") throw cause;
            });
        }
        return { root, created };
      },
      catch: (cause) =>
        new AntigravityThreadUploadsError({
          detail: "Could not prepare this thread's uploads for Antigravity.",
          cause,
        }),
    });
  },
);
