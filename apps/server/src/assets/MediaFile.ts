// @effect-diagnostics nodeBuiltinImport:off - FileSystem does not expose no-follow
// or non-blocking open flags, and the response must keep the validated descriptor.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import * as NodeStream from "@effect/platform-node/NodeStream";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

class MediaFileOpenError extends Schema.TaggedErrorClass<MediaFileOpenError>()(
  "MediaFileOpenError",
  {
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to open media file '${this.path}'.`;
  }
}

class MediaFileStatError extends Schema.TaggedErrorClass<MediaFileStatError>()(
  "MediaFileStatError",
  {
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read metadata for media file '${this.path}'.`;
  }
}

/** Holds the file identity and descriptor for one HTTP request, never a copy of its bytes. */
export interface OpenMediaFile {
  readonly handle: NodeFSP.FileHandle;
  readonly info: NodeFS.BigIntStats;
}

/** Opens a canonical media path once. Replacements cannot change the response's source. */
export const openMediaFile = Effect.fn("openMediaFile")(function* (
  filePath: string,
  identity?: { readonly device: string; readonly inode: string },
) {
  return yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const before = await NodeFSP.lstat(filePath, { bigint: true });
        if (!before.isFile() || before.ino === 0n) return null;
        if (
          identity &&
          (before.dev.toString() !== identity.device || before.ino.toString() !== identity.inode)
        ) {
          return null;
        }

        // Windows lacks these flags; the descriptor/path identity checks still apply.
        const handle = await NodeFSP.open(
          filePath,
          NodeFS.constants.O_RDONLY |
            (NodeFS.constants.O_NOFOLLOW ?? 0) |
            (NodeFS.constants.O_NONBLOCK ?? 0),
        );
        let accepted = false;
        try {
          const info = await handle.stat({ bigint: true });
          if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino) return null;
          if (
            identity &&
            (info.dev.toString() !== identity.device || info.ino.toString() !== identity.inode)
          ) {
            return null;
          }
          if ((await NodeFSP.realpath(filePath)) !== filePath) return null;
          const after = await NodeFSP.lstat(filePath, { bigint: true });
          if (!after.isFile() || info.dev !== after.dev || info.ino !== after.ino) return null;
          accepted = true;
          return { handle, info } satisfies OpenMediaFile;
        } finally {
          if (!accepted) await handle.close();
        }
      },
      catch: (cause) => new MediaFileOpenError({ path: filePath, cause }),
    }),
    (file) => (file ? Effect.promise(() => file.handle.close()) : Effect.void),
  );
});

export const statMediaFile = Effect.fn("statMediaFile")(function* (
  filePath: string,
  file: OpenMediaFile,
) {
  return yield* Effect.tryPromise({
    try: () => file.handle.stat({ bigint: true }),
    catch: (cause) => new MediaFileStatError({ path: filePath, cause }),
  });
});

export const streamMediaFile = (file: OpenMediaFile, offset: bigint, bytesToRead: bigint) => {
  const start = Number(offset);
  const end = Number(offset + bytesToRead - 1n);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    return null;
  }
  return NodeStream.fromReadable<Uint8Array>({
    evaluate: () =>
      file.handle.createReadStream({
        autoClose: false,
        start,
        end,
      }),
  });
};
