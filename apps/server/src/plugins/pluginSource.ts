// @effect-diagnostics nodeBuiltinImport:off -- Digesting opens every file with O_NOFOLLOW, which Effect's FileSystem cannot ask for.
// Consent covers every regular file, including hidden paths; links, special files and oversized trees are refused.
// The digest is a snapshot: later edits and code loaded outside the directory are outside its guarantee.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { PluginSource } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export interface PluginSourceLimits {
  readonly maxFiles: number;
  readonly maxBytes: number;
}

export const defaultPluginSourceLimits: PluginSourceLimits = {
  maxFiles: 10_000,
  maxBytes: 64 * 1024 * 1024,
};

class PluginSourceError extends Schema.TaggedError<PluginSourceError>()("PluginSourceError", {
  directory: Schema.String,
  reason: Schema.String,
}) {
  override get message(): string {
    return `Cannot read the plugin in ${this.directory}: ${this.reason}`;
  }
}

class Refusal {
  readonly reason: string;
  constructor(reason: string) {
    this.reason = reason;
  }
}

// Neither is defined on Windows, where opening never follows a link or waits on a FIFO.
// Non-blocking, so a file swapped for a FIFO opens at once and is refused below.
const OPEN_FLAGS =
  NodeFS.constants.O_RDONLY |
  (NodeFS.constants.O_NOFOLLOW ?? 0) |
  (NodeFS.constants.O_NONBLOCK ?? 0);

const walk = async (
  root: string,
  limits: PluginSourceLimits,
  signal: AbortSignal,
): Promise<DigestedFiles> => {
  const files: Array<string> = [];
  let declaredBytes = 0;
  const directories = [""];
  let directoryCount = 0;
  for (let index = 0; index < directories.length; index++) {
    const relative = directories[index]!;
    // Latin-1 preserves each filename byte while opendir bounds the listing buffer.
    const entries = await NodeFSP.opendir(NodePath.join(root, relative), { encoding: "latin1" });
    for await (const entry of entries) {
      if (signal.aborted) throw new Refusal("the inspection was cancelled.");
      const rawName = Buffer.from(entry.name, "latin1");
      const name = rawName.toString("utf8");
      if (!Buffer.from(name, "utf8").equals(rawName))
        throw new Refusal("a filename is not valid UTF-8.");
      const child = relative === "" ? name : `${relative}/${name}`;
      if (entry.isSymbolicLink()) throw new Refusal(`${child} is a symbolic link.`);
      if (entry.isDirectory()) {
        if (++directoryCount > limits.maxFiles)
          throw new Refusal(`it has more than ${limits.maxFiles} directories.`);
        directories.push(child);
        continue;
      }
      if (!entry.isFile()) throw new Refusal(`${child} is not a regular file.`);
      if (files.length >= limits.maxFiles)
        throw new Refusal(`it has more than ${limits.maxFiles} files.`);
      files.push(child);
      declaredBytes += (await NodeFSP.lstat(NodePath.join(root, child))).size;
      if (declaredBytes > limits.maxBytes)
        throw new Refusal(`it is larger than ${limits.maxBytes} bytes.`);
    }
  }
  // Code unit order of the relative path, independent of how the OS lists entries.
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const digest = NodeCrypto.createHash("sha256");
  const contents = new Map<string, string>();
  let bytes = 0;
  for (const file of files) {
    const content = NodeCrypto.createHash("sha256");
    let size = 0;
    // A file swapped for a link after listing is refused, not followed.
    const handle = await NodeFSP.open(NodePath.join(root, file), OPEN_FLAGS);
    try {
      if (!(await handle.stat()).isFile()) throw new Refusal(`${file} is not a regular file.`);
      for await (const chunk of handle.createReadStream({ autoClose: false, signal })) {
        size += chunk.length;
        if (bytes + size > limits.maxBytes)
          throw new Refusal(`it is larger than ${limits.maxBytes} bytes.`);
        content.update(chunk);
      }
    } finally {
      await handle.close();
    }
    bytes += size;
    const hash = content.digest("hex");
    contents.set(file, hash);
    digest.update(`${file}\0${size}\0${hash}\n`);
  }
  return {
    source: { digest: `sha256:${digest.digest("hex")}`, files: files.length, bytes },
    contents,
  };
};

interface DigestedFiles {
  readonly source: PluginSource;
  /** The SHA-256 (hex) of each file's content the digest covered, by `/`-separated relative path. */
  readonly contents: ReadonlyMap<string, string>;
}

/**
 * Digests `directory` (a real path) and keeps each file's content hash, so
 * bytes read separately can be matched to the very pass that was digested.
 */
export const digestPluginSourceFiles = (
  directory: string,
  limits: PluginSourceLimits = defaultPluginSourceLimits,
) =>
  Effect.tryPromise({
    try: (signal) => walk(directory, limits, signal),
    catch: (cause) =>
      new PluginSourceError({
        directory,
        reason:
          cause instanceof Refusal
            ? cause.reason
            : (cause as NodeJS.ErrnoException).code === "ELOOP"
              ? "a file was replaced by a symbolic link while it was read."
              : "a file could not be read.",
      }),
  }).pipe(Effect.withSpan("pluginSource.digest"));

/** Digests `directory` (a real path), or says why its bytes cannot be pinned. */
export const digestPluginSource = (
  directory: string,
  limits: PluginSourceLimits = defaultPluginSourceLimits,
) => digestPluginSourceFiles(directory, limits).pipe(Effect.map(({ source }) => source));
