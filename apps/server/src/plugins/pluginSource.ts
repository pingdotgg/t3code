// @effect-diagnostics nodeBuiltinImport:off
/**
 * Digest of a plugin directory's exact bytes, which consent binds to.
 *
 * Every regular file under the directory counts, by relative path and
 * content, so an edit, addition, removal, or rename changes the digest. No
 * name is exempt: the entry or anything it imports may live under any path,
 * hidden ones included. Symbolic links, special files, and trees past the
 * limits are refused rather than skipped: a digest that silently left
 * something out would not describe what runs. A plugin developed in a git
 * checkout should be added from a build directory, since `.git` counts too.
 *
 * The directory stays writable by its owner, so a digest describes the bytes
 * at the moment it was taken. Code the plugin loads from outside its
 * directory is not covered.
 */
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

// Not defined on Windows, where opening never follows a link anyway.
const OPEN_FLAGS = NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0);

const walk = async (
  root: string,
  limits: PluginSourceLimits,
  signal: AbortSignal,
): Promise<PluginSource> => {
  const files: Array<string> = [];
  let declaredBytes = 0;
  const visit = async (relative: string) => {
    const entries = await NodeFSP.readdir(NodePath.join(root, relative), { withFileTypes: true });
    for (const entry of entries) {
      if (signal.aborted) throw new Refusal("the inspection was cancelled.");
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Refusal(`${child} is a symbolic link.`);
      if (entry.isDirectory()) {
        await visit(child);
        continue;
      }
      if (!entry.isFile()) throw new Refusal(`${child} is not a regular file.`);
      files.push(child);
      if (files.length > limits.maxFiles)
        throw new Refusal(`it has more than ${limits.maxFiles} files.`);
      declaredBytes += (await NodeFSP.lstat(NodePath.join(root, child))).size;
      if (declaredBytes > limits.maxBytes)
        throw new Refusal(`it is larger than ${limits.maxBytes} bytes.`);
    }
  };
  await visit("");
  // Code unit order of the relative path, independent of how the OS lists entries.
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const digest = NodeCrypto.createHash("sha256");
  let bytes = 0;
  for (const file of files) {
    const content = NodeCrypto.createHash("sha256");
    let size = 0;
    // A file swapped for a link after listing is refused, not followed.
    const handle = await NodeFSP.open(NodePath.join(root, file), OPEN_FLAGS);
    try {
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
    digest.update(`${file}\0${size}\0${content.digest("hex")}\n`);
  }
  return { digest: `sha256:${digest.digest("hex")}`, files: files.length, bytes };
};

/** Digests `directory` (a real path), or says why its bytes cannot be pinned. */
export const digestPluginSource = (
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
