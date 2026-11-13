// @effect-diagnostics nodeBuiltinImport:off -- lstat, link counts and exclusive copies are filesystem boundaries missing from Effect's API.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeZlib from "node:zlib";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as HostProcess from "@t3tools/shared/HostProcess";

import { unsetInheritedRepositoryEnv } from "../vcs/VcsProcess.ts";

export const WORK_FILES_MAX_BYTES = 100 * 1024 * 1024;
export const WORK_FILES_MAX_COUNT = 5_000;
/** Room for tar headers and gzip framing on top of the file bytes. */
export const WORK_FILES_MAX_ARCHIVE_BYTES = WORK_FILES_MAX_BYTES + 16 * 1024 * 1024;

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".turbo",
  ".cache",
  "__pycache__",
]);

/** A repository's own folder; its hooks run on the next checkout, so no transfer writes into one. */
const isGitFolder = (segment: string) => segment.toLowerCase() === ".git";

/**
 * Names Windows resolves to `.git`: trailing dots or spaces, an NTFS stream after
 * a colon, or the 8.3 name `GIT~1`. Refused on every platform, as git's
 * `is_ntfs_dotgit` does, since the receiver's platform is unknown to the sender.
 */
const isWindowsGitAlias = (segment: string) => {
  const name = segment
    .toLowerCase()
    .split(":")[0]!
    .replace(/[. ]+$/, "");
  return name === ".git" || /^git~\d$/.test(name);
};

export class WorkFilesError extends Schema.TaggedError<WorkFilesError>()("WorkFilesError", {
  reason: Schema.Literals(["over_limit", "head_mismatch", "conflict", "invalid_archive", "failed"]),
  message: Schema.String,
}) {}

const isWorkFilesError = Schema.is(WorkFilesError);

const failed = (message: string) => new WorkFilesError({ reason: "failed", message });

export interface WorkFilesSelection {
  readonly root: string;
  /** The commit the files apply to; null outside git, "" in a repository with no commits. */
  readonly head: string | null;
  readonly files: ReadonlyArray<{ readonly path: string; readonly size: number }>;
  readonly deletions: ReadonlyArray<string>;
  readonly totalBytes: number;
  /** Why the set cannot go, with the numbers; nothing is sent when set. */
  readonly refusal: string | null;
}

const formatMiB = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

const fileSystemCall = <A>(what: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: () => failed(`Could not ${what}.`) });

const lstatOrNull = (path: string) => Effect.promise(() => NodeFSP.lstat(path).catch(() => null));

interface ProcessResult {
  readonly code: number;
  readonly stdout: Uint8Array;
  readonly stderr: string;
}

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.runFold(
      () => [] as Uint8Array[],
      (chunks, chunk) => {
        chunks.push(chunk);
        return chunks;
      },
    ),
    Effect.map((chunks) => Buffer.concat(chunks)),
  );

/** Runs a command to completion; git and tar never prompt, so stdin is closed or the given stream. */
const runProcess = Effect.fn("WorkFiles.runProcess")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly stdin?: Uint8Array },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(command, args, {
          cwd: options.cwd,
          env: { ...unsetInheritedRepositoryEnv(process.env, platform), LC_ALL: "C" },
          extendEnv: true,
          stdin: options.stdin === undefined ? "ignore" : Stream.make(options.stdin),
        }),
      );
      const [stdout, stderr] = yield* Effect.all([collect(child.stdout), collect(child.stderr)], {
        concurrency: "unbounded",
      });
      const code = yield* child.exitCode;
      return {
        code: Number(code),
        stdout,
        stderr: stderr.toString("utf8"),
      } satisfies ProcessResult;
    }),
  ).pipe(Effect.mapError(() => failed(`Could not run ${command}. Is it installed and on PATH?`)));
});

const nulSeparated = (bytes: Uint8Array) =>
  Buffer.from(bytes)
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry.length > 0);

const git = (cwd: string, args: ReadonlyArray<string>) => runProcess("git", args, { cwd });

/** The commit checked out at `cwd`, "" before the first commit, or null outside git. */
export const gitHead = Effect.fn("WorkFiles.gitHead")(function* (cwd: string) {
  const inside = yield* git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0) return null;
  const head = yield* git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]);
  return head.code === 0 ? Buffer.from(head.stdout).toString("utf8").trim() : "";
});

/** Paths under `cwd`, relative to it, that differ from HEAD: modified, staged, deleted, or untracked and not ignored. */
const gitChangedPaths = Effect.fn("WorkFiles.gitChangedPaths")(function* (cwd: string) {
  const [worktree, staged] = yield* Effect.all([
    git(cwd, ["ls-files", "-m", "-d", "-o", "--exclude-standard", "-z"]),
    git(cwd, ["diff", "--cached", "--name-only", "--relative", "--no-renames", "-z"]),
  ]);
  if (worktree.code !== 0 || staged.code !== 0) {
    return yield* failed("Could not read git status.");
  }
  return new Set([...nulSeparated(worktree.stdout), ...nulSeparated(staged.stdout)]);
});

const gitTrackedPaths = Effect.fn("WorkFiles.gitTrackedPaths")(function* (cwd: string) {
  const tracked = yield* git(cwd, ["ls-files", "-z"]);
  if (tracked.code !== 0) return yield* failed("Could not list tracked files.");
  return new Set(nulSeparated(tracked.stdout));
});

/** Every file under `root` outside skipped directories, stopping once past the count limit. */
const walk = Effect.fn("WorkFiles.walk")(function* (root: string) {
  const found: string[] = [];
  const pending = [""];
  while (pending.length > 0 && found.length <= WORK_FILES_MAX_COUNT) {
    const directory = pending.pop()!;
    const entries = yield* fileSystemCall("read the working directory", () =>
      NodeFSP.readdir(NodePath.join(root, directory), { withFileTypes: true }),
    );
    for (const entry of entries) {
      const relative = directory === "" ? entry.name : `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name) && !isGitFolder(entry.name)) {
          pending.push(relative);
        }
      } else if (entry.isFile()) {
        found.push(relative);
      }
    }
  }
  return found;
});

/** The files a thread's work consists of at `root`, checked against the limits. */
export const selectWorkFiles = Effect.fn("WorkFiles.select")(function* (root: string) {
  const head = yield* gitHead(root);
  const candidates = head === null ? yield* walk(root) : [...(yield* gitChangedPaths(root))];
  const files: Array<{ path: string; size: number }> = [];
  const deletions: string[] = [];
  const inodes = new Map<string, string>();
  let totalBytes = 0;
  for (const path of candidates.toSorted()) {
    // The receiving side refuses these, so they are never sent.
    if (!isSafeRelativePath(path)) continue;
    const stat = yield* lstatOrNull(NodePath.join(root, path));
    // Symlinks and submodule directories are not work files.
    if (stat !== null && !stat.isFile()) continue;
    if (stat === null) {
      if (head !== null) deletions.push(path);
      continue;
    }
    if (stat.nlink > 1) {
      const inode = `${stat.dev}:${stat.ino}`;
      const other = inodes.get(inode);
      if (other !== undefined) {
        return yield* failed(
          `${path} and ${other} are hard links to one file; tar cannot send both.`,
        );
      }
      inodes.set(inode, path);
    }
    files.push({ path, size: stat.size });
    totalBytes += stat.size;
  }
  const overCount = files.length > WORK_FILES_MAX_COUNT;
  const refusal =
    overCount || totalBytes > WORK_FILES_MAX_BYTES
      ? `The work files are ${overCount && head === null ? `more than ${WORK_FILES_MAX_COUNT.toLocaleString("en-US")}` : files.length.toLocaleString("en-US")} files and ${formatMiB(totalBytes)}; the limit is ${WORK_FILES_MAX_COUNT.toLocaleString("en-US")} files and ${formatMiB(WORK_FILES_MAX_BYTES)}.`
      : null;
  return {
    root,
    head,
    files,
    deletions,
    totalBytes,
    refusal,
  } satisfies WorkFilesSelection;
});

/** bsdtar (macOS, Windows) writes macOS metadata unless told not to; GNU tar has no such flag. */
const tarKind = (cwd: string) =>
  runProcess("tar", ["--version"], { cwd }).pipe(
    Effect.map((result) =>
      Buffer.from(result.stdout).toString("utf8").includes("bsdtar") ? "bsd" : "gnu",
    ),
  );

/**
 * A gzip tar of `files` under `root`, streamed from the system tar with no
 * file written here. The stream fails when tar does.
 */
export const archiveStream = (root: string, files: ReadonlyArray<string>) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const kind = yield* tarKind(root);
      const child = yield* spawner.spawn(
        ChildProcess.make(
          "tar",
          [
            ...(kind === "bsd" ? ["--no-mac-metadata", "--no-xattrs"] : []),
            "-czf",
            "-",
            "--null",
            "-T",
            "-",
          ],
          {
            cwd: root,
            env: { COPYFILE_DISABLE: "1" },
            extendEnv: true,
            stdin: Stream.make(new TextEncoder().encode(files.map((file) => `${file}\0`).join(""))),
          },
        ),
      );
      const finished = child.exitCode.pipe(
        Effect.flatMap((code) =>
          Number(code) === 0
            ? Effect.void
            : Effect.fail(failed(`tar could not archive the work files (exit ${code}).`)),
        ),
      );
      return child.stdout.pipe(Stream.concat(Stream.fromEffect(finished).pipe(Stream.drain)));
    }),
  ).pipe(
    Stream.mapError((error) =>
      error._tag === "WorkFilesError" ? error : failed("tar could not archive the work files."),
    ),
  );

const invalid = (message: string) => new WorkFilesError({ reason: "invalid_archive", message });

/** A relative path that stays inside the directory it is joined to, on any platform, and outside `.git`. */
export const isSafeRelativePath = (path: string) =>
  path.length > 0 &&
  !path.startsWith("/") &&
  !/^[A-Za-z]:/.test(path) &&
  !path.includes("\\") &&
  !path.includes("\0") &&
  path
    .split("/")
    .every((segment) => segment !== ".." && !isGitFolder(segment) && !isWindowsGitAlias(segment));

interface ArchiveEntry {
  readonly path: string;
  readonly type: "file" | "directory";
  readonly size: number;
}

const TAR_BLOCK = 512;
/** Pax and GNU long-name records hold a few names; a bigger one is not an archive a T3 server wrote. */
const TAR_MAX_METADATA_BYTES = 1024 * 1024;
const TAR_MAX_ENTRIES = WORK_FILES_MAX_COUNT * 4;
/** All pax and long-name records together, headers included; far above what real names need. */
const TAR_MAX_METADATA_TOTAL_BYTES = 64 * 1024 * 1024;

const nulTerminated = (bytes: Buffer) => {
  const end = bytes.indexOf(0);
  return (end === -1 ? bytes : bytes.subarray(0, end)).toString("utf8");
};

/** A tar number field: octal text, or GNU's base-256 with the high bit set. */
const tarNumber = (field: Buffer) => {
  if ((field[0]! & 0x80) !== 0) {
    if (field[0] === 0xff) return null;
    let value = field[0]! & 0x7f;
    for (const byte of field.subarray(1)) value = value * 256 + byte;
    return value;
  }
  const text = nulTerminated(field).trim();
  return text === "" ? 0 : /^[0-7]+$/.test(text) ? Number.parseInt(text, 8) : null;
};

/** Pax records, `<length> <key>=<value>\n` each, with the length counting bytes. */
const paxRecords = (data: Buffer) => {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const length =
      space === -1 ? Number.NaN : Number(data.subarray(offset, space).toString("latin1"));
    if (
      !Number.isInteger(length) ||
      offset + length > data.length ||
      length <= space - offset + 1
    ) {
      throw invalid("The archive has a malformed pax header.");
    }
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals === -1) throw invalid("The archive has a malformed pax header.");
    records.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }
  return records;
};

const checksumMatches = (header: Buffer) => {
  const stored = tarNumber(header.subarray(148, 156));
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < TAR_BLOCK; index++) {
    const byte = index >= 148 && index < 156 ? 0x20 : header[index]!;
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  return stored === unsigned || stored === signed;
};

/**
 * The entries of a gzip tar, read from its headers here rather than from a tar
 * listing, which escapes non-ASCII names. Refuses links and special files, and
 * stops as soon as the files pass the count or expanded size limit.
 */
const readArchiveEntries = async (archivePath: string) => {
  const gunzip = NodeZlib.createGunzip();
  NodeStream.pipeline(NodeFS.createReadStream(archivePath), gunzip, () => undefined);
  const entries: ArchiveEntry[] = [];
  let buffer: Buffer = Buffer.alloc(0);
  let skip = 0;
  let collecting: { readonly type: string; readonly size: number } | null = null;
  let pax = new Map<string, string>();
  let longName: string | null = null;
  let fileCount = 0;
  let expandedBytes = 0;
  let metadataBytes = 0;
  let ended = false;
  try {
    for await (const chunk of gunzip as AsyncIterable<Buffer>) {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      let offset = 0;
      while (!ended) {
        if (skip > 0) {
          const taken = Math.min(skip, buffer.length - offset);
          skip -= taken;
          offset += taken;
          if (skip > 0) break;
          continue;
        }
        if (collecting !== null) {
          if (buffer.length - offset < collecting.size) break;
          const data = Buffer.from(buffer.subarray(offset, offset + collecting.size));
          offset += collecting.size;
          skip = (TAR_BLOCK - (collecting.size % TAR_BLOCK)) % TAR_BLOCK;
          if (collecting.type === "x") pax = paxRecords(data);
          if (collecting.type === "L") longName = nulTerminated(data);
          collecting = null;
          continue;
        }
        if (buffer.length - offset < TAR_BLOCK) break;
        const header = buffer.subarray(offset, offset + TAR_BLOCK);
        offset += TAR_BLOCK;
        if (header.every((byte) => byte === 0)) {
          ended = true;
          break;
        }
        if (!checksumMatches(header)) throw invalid("The archive could not be read.");
        const flag = header[156] === 0 ? "0" : String.fromCharCode(header[156]!);
        const headerSize = tarNumber(header.subarray(124, 136));
        const paxSize = pax.get("size");
        // The bytes stored in the archive, which a sparse file's map and data make smaller than the file.
        const size = paxSize === undefined ? headerSize : Number(paxSize);
        const sparseSize =
          pax.get("GNU.sparse.realsize") ??
          pax.get("GNU.sparse.size") ??
          (flag === "S" ? tarNumber(header.subarray(483, 495)) : null);
        const expanded = sparseSize === null ? size : Number(sparseSize);
        if (
          size === null ||
          expanded === null ||
          !Number.isSafeInteger(size) ||
          !Number.isSafeInteger(expanded) ||
          size < 0 ||
          expanded < 0
        ) {
          throw invalid("The archive could not be read.");
        }
        // GNU tar applies a global header's size to every later entry; T3 never writes one.
        if (flag === "g") throw invalid("The archive has a global pax header.");
        // Metadata for the entry after it: pax records and GNU long names.
        if (flag === "x" || flag === "L" || flag === "K") {
          if (size > TAR_MAX_METADATA_BYTES) throw invalid("The archive has an oversized header.");
          metadataBytes += TAR_BLOCK + size;
          if (metadataBytes > TAR_MAX_METADATA_TOTAL_BYTES) {
            throw invalid("The archive has too many header records.");
          }
          collecting = { type: flag, size };
          continue;
        }
        const ustarPrefix =
          header.subarray(257, 263).toString("latin1") === "ustar\0"
            ? nulTerminated(header.subarray(345, 500))
            : "";
        const headerName = nulTerminated(header.subarray(0, 100));
        const path =
          longName ??
          pax.get("GNU.sparse.name") ??
          pax.get("path") ??
          (ustarPrefix === "" ? headerName : `${ustarPrefix}/${headerName}`);
        pax = new Map();
        longName = null;
        const isDirectory = flag === "5" || ((flag === "0" || flag === "7") && path.endsWith("/"));
        if (!isDirectory && flag !== "0" && flag !== "7" && flag !== "S") {
          throw invalid(
            "The archive holds a link or special file; only regular files are accepted.",
          );
        }
        entries.push({ path, type: isDirectory ? "directory" : "file", size: expanded });
        if (entries.length > TAR_MAX_ENTRIES) {
          throw invalid(`The archive holds more than ${TAR_MAX_ENTRIES} entries.`);
        }
        if (!isDirectory) {
          fileCount += 1;
          expandedBytes += expanded;
          if (fileCount > WORK_FILES_MAX_COUNT) {
            throw invalid(`The archive holds more than ${WORK_FILES_MAX_COUNT} files.`);
          }
          if (expandedBytes > WORK_FILES_MAX_BYTES) {
            throw new WorkFilesError({
              reason: "over_limit",
              message: `The archive expands to more than ${formatMiB(WORK_FILES_MAX_BYTES)}, the limit.`,
            });
          }
          skip = size + ((TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK);
        }
      }
      buffer = buffer.subarray(offset);
      if (ended) break;
    }
  } finally {
    gunzip.destroy();
  }
  if (!ended) throw invalid("The archive could not be read.");
  return entries;
};

/**
 * The regular files an archive holds, refusing absolute paths, `..`, `.git`,
 * any entry that is not a file or directory, and a set over the limits.
 */
export const listArchive = Effect.fn("WorkFiles.listArchive")(function* (archivePath: string) {
  const entries = yield* Effect.tryPromise({
    try: () => readArchiveEntries(archivePath),
    catch: (error) => (isWorkFilesError(error) ? error : invalid("The archive could not be read.")),
  });
  const files: Array<{ readonly path: string; readonly size: number }> = [];
  for (const entry of entries) {
    const name = entry.path.startsWith("./") ? entry.path.slice(2) : entry.path;
    const path = name.endsWith("/") ? name.slice(0, -1) : name;
    if (path === "" || path === ".") continue;
    if (!isSafeRelativePath(path)) {
      return yield* invalid(`The archive holds an unsafe path: "${entry.path}".`);
    }
    if (entry.type === "file") files.push({ path, size: entry.size });
  }
  return files;
});

/** Checks the extracted tree is only directories and single-link files, exactly those listed at their listed sizes. */
const verifyStaging = Effect.fn("WorkFiles.verifyStaging")(function* (
  staging: string,
  listed: ReadonlyArray<{ readonly path: string; readonly size: number }>,
) {
  // Some tars change a name's Unicode normalization on the way to disk, as macOS bsdtar does.
  const expected = new Map(listed.map((file) => [file.path.normalize("NFC"), file.size]));
  const pending = [""];
  let seen = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = yield* fileSystemCall("read the extracted files", () =>
      NodeFSP.readdir(NodePath.join(staging, directory), { withFileTypes: true }),
    );
    for (const entry of entries) {
      const relative = directory === "" ? entry.name : `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        pending.push(relative);
        continue;
      }
      const stat = yield* lstatOrNull(NodePath.join(staging, relative));
      if (
        stat === null ||
        !stat.isFile() ||
        stat.nlink > 1 ||
        expected.get(relative.normalize("NFC")) !== stat.size
      ) {
        return yield* invalid(`The archive extracted an unexpected entry: ${relative}.`);
      }
      seen += 1;
    }
  }
  if (seen !== expected.size)
    return yield* invalid("The archive did not extract every listed file.");
});

/** Why writing `path` under `root` could change something it must not, or null when it is safe. */
const targetConflict = Effect.fn("WorkFiles.targetConflict")(function* (
  root: string,
  path: string,
  local: { readonly changed: ReadonlySet<string>; readonly tracked: ReadonlySet<string> } | null,
  incoming: string | null,
) {
  const segments = path.split("/");
  // Missing there is a new file, unless someone deleted it there: writing it would undo that.
  const missing = incoming !== null && local?.changed.has(path) ? "it was deleted there" : null;
  for (let index = 1; index < segments.length; index++) {
    const parent = yield* lstatOrNull(NodePath.join(root, ...segments.slice(0, index)));
    if (parent === null) return missing;
    if (!parent.isDirectory()) return "a parent folder is a link or a file there";
  }
  const stat = yield* lstatOrNull(NodePath.join(root, ...segments));
  if (stat === null) return missing;
  if (!stat.isFile()) return "it is a link or a folder there";
  // An identical file is no change, so sending the same work again is a no-op.
  if (incoming !== null) {
    // Sizes first, so a large file there is read only when it could be identical.
    const incomingSize = yield* fileSystemCall("read an extracted file", () =>
      NodeFSP.lstat(incoming).then((file) => file.size),
    );
    if (incomingSize === stat.size) {
      const [here, there] = yield* Effect.all([
        fileSystemCall("read a file there", () =>
          NodeFSP.readFile(NodePath.join(root, ...segments)),
        ),
        fileSystemCall("read an extracted file", () => NodeFSP.readFile(incoming)),
      ]);
      if (here.equals(there)) return null;
    }
    // Copying onto it would change its other names too.
    if (stat.nlink > 1) return "it is a hard link to another file there";
  }
  // Outside git nothing records local changes, so only an identical file may be replaced.
  if (local === null) return "it already exists there with other content";
  if (local.changed.has(path)) return "it has local changes there";
  if (!local.tracked.has(path)) return "it is an untracked file there";
  return null;
});

/** One lock per checkout, by its resolved path, held from the conflict checks through the copy. */
const checkoutLocks = new Map<string, Semaphore.Semaphore>();

const checkoutLock = (root: string) =>
  Effect.promise(() => NodeFSP.realpath(root).catch(() => NodePath.resolve(root))).pipe(
    Effect.map((key) => {
      const existing = checkoutLocks.get(key);
      if (existing !== undefined) return existing;
      const lock = Semaphore.makeUnsafe(1);
      checkoutLocks.set(key, lock);
      return lock;
    }),
  );

/** Moves the backups of files a rollback could not restore out of staging, into a new dated folder. */
const keepBackups = async (
  keptBackupsDir: string,
  stamp: string,
  backups: string,
  unrestored: ReadonlyArray<{ readonly backup: string | null }>,
) => {
  await NodeFSP.mkdir(keptBackupsDir, { recursive: true });
  const kept = await NodeFSP.mkdtemp(NodePath.join(keptBackupsDir, `${stamp}-`));
  for (const { backup } of unrestored) {
    if (backup === null) continue;
    const destination = NodePath.join(kept, NodePath.relative(backups, backup));
    await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
    await NodeFSP.rename(backup, destination);
  }
  return kept;
};

/**
 * Copies the staged files into `root` and applies the deletions, backing up
 * each file it replaces or deletes. On any failure it puts those back and
 * removes the files and folders it added, so a refusal changes nothing.
 */
const copyIn = async (input: {
  readonly root: string;
  readonly staged: string;
  readonly backups: string;
  readonly keptBackupsDir: string;
  /** Names the folder kept backups go in. */
  readonly stamp: string;
  readonly files: ReadonlyArray<string>;
  readonly deletions: ReadonlyArray<string>;
}) => {
  const changed: Array<{ readonly destination: string; readonly backup: string | null }> = [];
  const createdFolders: string[] = [];
  const exists = (path: string) =>
    NodeFSP.lstat(path).then(
      () => true,
      () => false,
    );
  const backUp = async (path: string, destination: string) => {
    const backup = NodePath.join(input.backups, ...path.split("/"));
    await NodeFSP.mkdir(NodePath.dirname(backup), { recursive: true });
    await NodeFSP.copyFile(destination, backup);
    return backup;
  };
  let step = "";
  try {
    for (const path of input.files) {
      step = `write ${path}`;
      const segments = path.split("/");
      const destination = NodePath.join(input.root, ...segments);
      let backup: string | null = null;
      if (await exists(destination)) {
        backup = await backUp(path, destination);
      } else {
        for (let index = 1; index < segments.length; index++) {
          const folder = NodePath.join(input.root, ...segments.slice(0, index));
          if (!(await exists(folder))) createdFolders.push(folder);
        }
        await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
      }
      changed.push({ destination, backup });
      await NodeFSP.copyFile(NodePath.join(input.staged, ...segments), destination);
    }
    let deleted = 0;
    for (const path of input.deletions) {
      step = `delete ${path}`;
      const destination = NodePath.join(input.root, ...path.split("/"));
      if (!(await exists(destination))) continue;
      changed.push({ destination, backup: await backUp(path, destination) });
      await NodeFSP.rm(destination);
      deleted += 1;
    }
    return deleted;
  } catch {
    const unrestored: Array<{ readonly path: string; readonly backup: string | null }> = [];
    for (const { destination, backup } of changed.toReversed()) {
      await (
        backup === null
          ? NodeFSP.rm(destination, { force: true })
          : NodeFSP.copyFile(backup, destination)
      ).catch(() => unrestored.push({ path: NodePath.relative(input.root, destination), backup }));
    }
    for (const folder of createdFolders.toReversed()) {
      await NodeFSP.rmdir(folder).catch(() => undefined);
    }
    if (unrestored.length === 0)
      throw failed(`Could not ${step} there; nothing was changed there.`);
    const names = unrestored.map((file) => file.path).join(", ");
    const kept = await keepBackups(
      input.keptBackupsDir,
      input.stamp,
      input.backups,
      unrestored,
    ).catch(() => null);
    throw failed(
      kept === null
        ? `Could not ${step} there, and could not put back ${names}; their backups are lost.`
        : `Could not ${step} there, and could not put back ${names}; their earlier contents are in ${kept}.`,
    );
  }
};

export interface ApplyWorkFilesInput {
  readonly archivePath: string;
  readonly stagingDir: string;
  /** Where backups a failed rollback could not put back are kept, in a dated folder. */
  readonly keptBackupsDir: string;
  readonly root: string;
  /** The source's HEAD; null when the source is not a git checkout. */
  readonly head: string | null;
  readonly deletions: ReadonlyArray<string>;
}

/**
 * Applies a received archive to `root`: checks it, extracts it under
 * `stagingDir`, refuses on a HEAD mismatch or any path with local changes,
 * then copies the files in and applies the deletions, undoing them all if any
 * fails. The caller owns removing `archivePath` and `stagingDir`.
 */
export const applyWorkFiles = Effect.fn("WorkFiles.apply")(function* (input: ApplyWorkFilesInput) {
  const files = yield* listArchive(input.archivePath);
  // A folder outside git has no record of what the source deleted.
  if (input.head === null && input.deletions.length > 0) {
    return yield* invalid("The files come from a folder outside git, which cannot send deletions.");
  }
  for (const path of input.deletions) {
    if (!isSafeRelativePath(path)) {
      return yield* invalid(`A deletion names an unsafe path: "${path}".`);
    }
  }
  // A second write or delete of one path would back up the first one's result, not the original.
  const seen = new Set<string>();
  for (const path of [...files.map((file) => file.path), ...input.deletions]) {
    const key = path.normalize("NFC");
    if (seen.has(key)) return yield* invalid(`The work files name ${path} more than once.`);
    seen.add(key);
  }
  const lock = yield* checkoutLock(input.root);
  // A half-applied copy cannot be left behind: once the lock is held, the apply
  // and any rollback run to the end before an interruption lands, and only
  // then are the lock and the caller's staging released.
  return yield* Semaphore.withPermit(lock, applyLocked(input, files));
});

const applyLocked = Effect.fn("WorkFiles.applyLocked")(function* (
  input: ApplyWorkFilesInput,
  listed: ReadonlyArray<{ readonly path: string; readonly size: number }>,
) {
  const files = listed.map((file) => file.path);
  const staged = NodePath.join(input.stagingDir, "files");
  const head = yield* gitHead(input.root);
  if (input.head !== null) {
    if (head === null) {
      return yield* new WorkFilesError({
        reason: "head_mismatch",
        message:
          "The files come from a git checkout, but the checkout there is not a git repository.",
      });
    }
    if (head !== input.head) {
      return yield* new WorkFilesError({
        reason: "head_mismatch",
        message: `The checkout there is at ${head || "no commit"}, but the files apply to ${input.head || "no commit"}. Check out the same commit there first.`,
      });
    }
  }
  yield* fileSystemCall("create the staging folder", () =>
    NodeFSP.mkdir(staged, { recursive: true }),
  );
  const needed = listed.reduce((total, file) => total + file.size, 0);
  const space = yield* fileSystemCall("check free disk space", () => NodeFSP.statfs(staged));
  if (space.bavail * space.bsize < needed) {
    return yield* new WorkFilesError({
      reason: "over_limit",
      message: `The work files are ${formatMiB(needed)}, more than the free disk space there.`,
    });
  }
  const extracted = yield* runProcess("tar", ["-xzf", input.archivePath, "-C", staged], {
    cwd: staged,
  });
  if (extracted.code !== 0) return yield* invalid("The archive could not be extracted.");
  yield* verifyStaging(staged, listed);
  const local =
    head === null
      ? null
      : {
          changed: yield* gitChangedPaths(input.root),
          tracked: yield* gitTrackedPaths(input.root),
        };
  const conflicts: string[] = [];
  for (const path of files) {
    const reason = yield* targetConflict(
      input.root,
      path,
      local,
      NodePath.join(staged, ...path.split("/")),
    );
    if (reason !== null) conflicts.push(`${path} (${reason})`);
  }
  for (const path of input.deletions) {
    const reason = yield* targetConflict(input.root, path, local, null);
    if (reason !== null) conflicts.push(`${path} (${reason})`);
  }
  if (conflicts.length > 0) {
    return yield* new WorkFilesError({
      reason: "conflict",
      message: `Nothing was changed there, because these paths would overwrite local work: ${conflicts.slice(0, 20).join(", ")}${conflicts.length > 20 ? `, and ${conflicts.length - 20} more` : ""}.`,
    });
  }
  const stamp = DateTime.formatIso(yield* DateTime.now).replaceAll(":", "-");
  // The caller removes staging when this ends, so a started copy runs to its end or rollback.
  const deleted = yield* Effect.tryPromise({
    try: () =>
      copyIn({
        root: input.root,
        staged,
        backups: NodePath.join(input.stagingDir, "backup"),
        keptBackupsDir: input.keptBackupsDir,
        stamp,
        files,
        deletions: input.deletions,
      }),
    catch: (error) => (isWorkFilesError(error) ? error : failed("Could not apply the work files.")),
  }).pipe(Effect.withSpan("WorkFiles.copyIn"), Effect.uninterruptible);
  return { files: files.length, deletions: deleted };
});
