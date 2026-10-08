// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import {
  RuntimeMode,
  ProviderInteractionMode,
  ChatAttachment,
  IsoDateTime,
} from "@t3tools/contracts";
import {
  SESSION_TRANSFER_EXCLUDED_DIRECTORIES,
  SESSION_TRANSFER_MAX_BYTES,
} from "@t3tools/contracts";

const Metadata = Schema.Struct({
  version: Schema.Literal(1),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  title: Schema.String,
  sourceThreadId: Schema.String,
  branch: Schema.NullOr(Schema.String),
  hasCommit: Schema.Boolean,
  hasGit: Schema.Boolean,
  messages: Schema.Array(
    Schema.Struct({
      role: Schema.Literals(["user", "assistant", "system"]),
      text: Schema.String,
      createdAt: IsoDateTime,
      attachments: Schema.Array(ChatAttachment),
    }),
  ),
});
export type TransferMetadata = typeof Metadata.Type;
const Header = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("metadata"), metadata: Metadata }),
  Schema.Struct({
    kind: Schema.Literals(["file", "directory", "bundle", "index", "attachment"]),
    path: Schema.String,
    size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    mode: Schema.Int,
  }),
  Schema.Struct({ kind: Schema.Literal("end") }),
]);
const decodeHeader = Schema.decodeUnknownSync(Header);
const MAX_HEADER_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 50_000;
export class TransferArchiveFailure extends Error {}

function safeRelativePath(path: string): void {
  if (
    !path ||
    path.includes("\\") ||
    path.includes(":") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path
      .split("/")
      .some(
        (p) =>
          !p ||
          p === "." ||
          p === ".." ||
          p.toLowerCase() === ".git" ||
          /[. ]$/.test(p) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
      )
  ) {
    throw new TransferArchiveFailure(
      "The workspace contains a path that cannot be transferred safely.",
    );
  }
}

async function entries(root: string, tracked: ReadonlySet<string>) {
  const result: Array<{ path: string; size: number; mode: number; directory: boolean }> = [];
  async function walk(relative: string, depth: number) {
    if (depth > 64)
      throw new TransferArchiveFailure(
        "The workspace directory nesting exceeds the transfer limit.",
      );
    for (const entry of (
      await NodeFSP.readdir(NodePath.join(root, relative), { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.name === ".git" && !relative) continue;
      if (entry.name === ".git")
        throw new TransferArchiveFailure(
          "Nested repositories and submodules must be transferred separately.",
        );
      if (
        entry.isDirectory() &&
        SESSION_TRANSFER_EXCLUDED_DIRECTORIES.some((n) => n === entry.name) &&
        ![...tracked].some((p) => p === path || p.startsWith(`${path}/`))
      )
        continue;
      safeRelativePath(path);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))
        throw new TransferArchiveFailure(
          "This workspace contains symbolic links or special files. Replace them with regular files before transferring.",
        );
      const stat = await NodeFSP.lstat(NodePath.join(root, path));
      result.push({
        path,
        size: entry.isDirectory() ? 0 : stat.size,
        mode: stat.mode & 0o777,
        directory: entry.isDirectory(),
      });
      if (result.length > MAX_ENTRIES)
        throw new TransferArchiveFailure("The workspace has too many files for a transfer.");
      if (entry.isDirectory()) await walk(path, depth + 1);
    }
  }
  await walk("", 0);
  if (result.reduce((total, entry) => total + entry.size, 0) > SESSION_TRANSFER_MAX_BYTES)
    throw new TransferArchiveFailure("The workspace exceeds the 100 MB transfer limit.");
  return result;
}

/** A bounded, length-framed archive: file bodies are streamed, never base64 or WebSocket payloads. */
export async function writeTransferArchive(input: {
  root: string;
  output: string;
  metadata: TransferMetadata;
  tracked: ReadonlySet<string>;
  bundlePath: string | null;
  indexPath: string | null;
  attachments: ReadonlyMap<string, string>;
}) {
  const hash = NodeCrypto.createHash("sha256");
  const handle = await NodeFSP.open(input.output, "wx", 0o600);
  let size = 0;
  async function write(bytes: Uint8Array, fingerprint = true) {
    size += bytes.byteLength;
    if (size > SESSION_TRANSFER_MAX_BYTES)
      throw new TransferArchiveFailure(
        "The workspace exceeds the 100 MB transfer limit. Remove large generated files and try again.",
      );
    if (fingerprint) hash.update(bytes);
    let offset = 0;
    while (offset < bytes.length) offset += (await handle.write(bytes, offset)).bytesWritten;
  }
  async function header(value: typeof Header.Type, fingerprint = true) {
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > MAX_HEADER_BYTES)
      throw new TransferArchiveFailure("The conversation exceeds the transfer context limit.");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    await write(length, fingerprint);
    await write(bytes, fingerprint);
  }
  async function body(file: string, bytes: number, fingerprint = true) {
    const source = await NodeFSP.open(file, "r");
    try {
      const buffer = Buffer.alloc(64 * 1024);
      let remaining = bytes;
      while (remaining > 0) {
        const read = await source.read(buffer, 0, Math.min(buffer.length, remaining));
        if (!read.bytesRead)
          throw new TransferArchiveFailure(
            "The remote workspace changed during transfer. Try again when it is idle.",
          );
        await write(buffer.subarray(0, read.bytesRead), fingerprint);
        remaining -= read.bytesRead;
      }
      if ((await source.stat()).size !== bytes)
        throw new TransferArchiveFailure(
          "The remote workspace changed during transfer. Try again when it is idle.",
        );
    } finally {
      await source.close();
    }
  }
  try {
    await header({ kind: "metadata", metadata: input.metadata });
    // Bundles are not byte-stable between Git invocations. Fingerprint HEAD and index separately in the service.
    for (const [kind, file] of [
      ["bundle", input.bundlePath],
      ["index", input.indexPath],
    ] as const) {
      if (!file) continue;
      const bytes = (await NodeFSP.stat(file)).size;
      await header({ kind, path: kind, size: bytes, mode: 0o600 }, false);
      if (size + bytes > SESSION_TRANSFER_MAX_BYTES)
        throw new TransferArchiveFailure(
          "The repository history exceeds the 100 MB transfer limit.",
        );
      await body(file, bytes, false);
    }
    for (const [id, file] of input.attachments) {
      safeRelativePath(id);
      if (id.includes("/")) throw new TransferArchiveFailure("Invalid attachment id.");
      const bytes = (await NodeFSP.stat(file)).size;
      await header({ kind: "attachment", path: id, size: bytes, mode: 0o600 }, false);
      if (size + bytes > SESSION_TRANSFER_MAX_BYTES)
        throw new TransferArchiveFailure(
          "The project and attachments exceed the 100 MB transfer limit.",
        );
      await body(file, bytes, false);
    }
    for (const entry of await entries(input.root, input.tracked)) {
      await header({
        kind: entry.directory ? "directory" : "file",
        path: entry.path,
        size: entry.size,
        mode: entry.mode,
      });
      if (!entry.directory) await body(NodePath.join(input.root, entry.path), entry.size);
    }
    await header({ kind: "end" });
    return { sizeBytes: size, fingerprint: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

export async function workspaceFingerprint(
  root: string,
  metadata: TransferMetadata,
  tracked: ReadonlySet<string>,
) {
  // Use exactly the same framing as capture, without writing an extra archive to disk.
  const hash = NodeCrypto.createHash("sha256");
  const header = (value: typeof Header.Type) => {
    const bytes = Buffer.from(JSON.stringify(value));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  };
  header({ kind: "metadata", metadata });
  for (const entry of await entries(root, tracked)) {
    header({
      kind: entry.directory ? "directory" : "file",
      path: entry.path,
      size: entry.size,
      mode: entry.mode,
    });
    if (!entry.directory) {
      const file = await NodeFSP.open(NodePath.join(root, entry.path), "r");
      try {
        const buffer = Buffer.alloc(64 * 1024);
        for (;;) {
          const { bytesRead } = await file.read(buffer);
          if (!bytesRead) break;
          hash.update(buffer.subarray(0, bytesRead));
        }
      } finally {
        await file.close();
      }
    }
  }
  header({ kind: "end" });
  return hash.digest("hex");
}

export async function readTransferArchive(input: {
  archive: string;
  root: string;
  gitData: string;
}) {
  const handle = await NodeFSP.open(input.archive, "r");
  let consumed = 0;
  const total = (await handle.stat()).size;
  if (total > SESSION_TRANSFER_MAX_BYTES) {
    await handle.close();
    throw new TransferArchiveFailure("The transfer exceeds the 100 MB limit.");
  }
  async function read(size: number) {
    if (consumed + size > total)
      throw new TransferArchiveFailure("The transfer archive is incomplete.");
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(bytes, offset, size - offset);
      if (!bytesRead) throw new TransferArchiveFailure("The transfer archive is incomplete.");
      offset += bytesRead;
    }
    consumed += size;
    return bytes;
  }
  let metadata: TransferMetadata | null = null;
  const seen = new Set<string>();
  try {
    for (let count = 0; count <= MAX_ENTRIES + 4; count++) {
      const length = (await read(4)).readUInt32BE();
      if (!length || length > MAX_HEADER_BYTES)
        throw new TransferArchiveFailure("Invalid transfer archive header.");
      const record = decodeHeader(JSON.parse((await read(length)).toString()));
      if (record.kind === "metadata") {
        if (metadata || count !== 0) throw new TransferArchiveFailure("Invalid transfer metadata.");
        metadata = record.metadata;
        continue;
      }
      if (!metadata) throw new TransferArchiveFailure("Missing transfer metadata.");
      if (record.kind === "end") {
        if (consumed !== total)
          throw new TransferArchiveFailure("Unexpected data after transfer archive.");
        return metadata;
      }
      const key = `${record.kind === "bundle" || record.kind === "index" || record.kind === "attachment" ? "git" : "workspace"}/${record.path}`;
      if (seen.has(key)) throw new TransferArchiveFailure("Duplicate transfer archive path.");
      seen.add(key);
      if (record.kind === "file" || record.kind === "directory") safeRelativePath(record.path);
      else if (record.kind === "attachment") {
        safeRelativePath(record.path);
        if (record.path.includes("/")) throw new TransferArchiveFailure("Invalid attachment id.");
      } else if (record.path !== record.kind)
        throw new TransferArchiveFailure("Invalid Git transfer data.");
      const destination =
        record.kind === "attachment"
          ? NodePath.join(input.gitData, "attachments", record.path)
          : NodePath.join(
              record.kind === "bundle" || record.kind === "index" ? input.gitData : input.root,
              record.path,
            );
      if (record.kind === "directory") {
        if (record.size !== 0) throw new TransferArchiveFailure("Invalid directory entry.");
        await NodeFSP.mkdir(destination, { recursive: true });
        continue;
      }
      await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
      const file = await NodeFSP.open(destination, "wx", 0o600);
      try {
        let remaining = record.size;
        while (remaining > 0) {
          const bytes = await read(Math.min(remaining, 64 * 1024));
          let offset = 0;
          while (offset < bytes.length) offset += (await file.write(bytes, offset)).bytesWritten;
          remaining -= bytes.length;
        }
        await file.chmod(record.mode & 0o777);
      } finally {
        await file.close();
      }
    }
    throw new TransferArchiveFailure("The transfer has too many entries.");
  } finally {
    await handle.close();
  }
}
