// @effect-diagnostics nodeBuiltinImport:off -- lstat, link counts and exclusive copies are filesystem boundaries missing from Effect's API.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
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

export class WorkFilesError extends Schema.TaggedError<WorkFilesError>()("WorkFilesError", {
  reason: Schema.Literals(["over_limit", "head_mismatch", "conflict", "invalid_archive", "failed"]),
  message: Schema.String,
}) {}

const failed = (message: string) => new WorkFilesError({ reason: "failed", message });

/** Files that look like credentials never leave the machine they are on. */
const looksLikeSecret = (path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  return (
    name.startsWith(".env") ||
    name.endsWith(".pem") ||
    name.endsWith(".key") ||
    name.endsWith(".p12") ||
    name.startsWith("id_rsa") ||
    name === ".npmrc" ||
    name === ".netrc"
  );
};

export interface WorkFilesSelection {
  readonly root: string;
  /** The commit the files apply to; null outside git, "" in a repository with no commits. */
  readonly head: string | null;
  readonly files: ReadonlyArray<{ readonly path: string; readonly size: number }>;
  readonly deletions: ReadonlyArray<string>;
  readonly leftBehind: ReadonlyArray<string>;
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
        if (!SKIPPED_DIRECTORIES.has(entry.name)) pending.push(relative);
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
  const leftBehind: string[] = [];
  const inodes = new Map<string, string>();
  let totalBytes = 0;
  for (const path of candidates.toSorted()) {
    const stat = yield* lstatOrNull(NodePath.join(root, path));
    if (stat === null) {
      if (head !== null) deletions.push(path);
      continue;
    }
    // Symlinks and submodule directories are not work files.
    if (!stat.isFile()) continue;
    if (looksLikeSecret(path)) {
      leftBehind.push(path);
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
    leftBehind,
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

/** A relative path that stays inside the directory it is joined to, on any platform. */
export const isSafeRelativePath = (path: string) =>
  path.length > 0 &&
  !path.startsWith("/") &&
  !/^[A-Za-z]:/.test(path) &&
  !path.includes("\\") &&
  !path.includes("\0") &&
  path.split("/").every((segment) => segment !== "..");

/**
 * The regular files an archive holds, refusing absolute paths, `..`, and any
 * entry that is not a file or directory, such as a symlink or hard link.
 */
export const listArchive = Effect.fn("WorkFiles.listArchive")(function* (
  archivePath: string,
  cwd: string,
) {
  const [names, verbose] = yield* Effect.all([
    runProcess("tar", ["-tzf", archivePath], { cwd }),
    runProcess("tar", ["-tvzf", archivePath], { cwd }),
  ]);
  if (names.code !== 0 || verbose.code !== 0) {
    return yield* invalid("The archive could not be read.");
  }
  const lines = (bytes: Uint8Array) =>
    Buffer.from(bytes)
      .toString("utf8")
      .split("\n")
      .filter((line) => line.length > 0);
  for (const line of lines(verbose.stdout)) {
    // Each entry's listing starts with its type; a name with a newline lands here too and is refused.
    if (line[0] !== "-" && line[0] !== "d") {
      return yield* invalid(
        "The archive holds a link or special file; only regular files are accepted.",
      );
    }
  }
  const files: string[] = [];
  for (const raw of lines(names.stdout)) {
    const name = raw.startsWith("./") ? raw.slice(2) : raw;
    const path = name.endsWith("/") ? name.slice(0, -1) : name;
    if (path === "" || path === ".") continue;
    if (!isSafeRelativePath(path)) {
      return yield* invalid(`The archive holds an unsafe path: "${raw}".`);
    }
    if (!name.endsWith("/")) files.push(path);
  }
  if (files.length > WORK_FILES_MAX_COUNT) {
    return yield* invalid(`The archive holds more than ${WORK_FILES_MAX_COUNT} files.`);
  }
  return files;
});

/** Checks the extracted tree is only directories and single-link files, exactly those listed. */
const verifyStaging = Effect.fn("WorkFiles.verifyStaging")(function* (
  staging: string,
  expected: ReadonlySet<string>,
) {
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
      if (stat === null || !stat.isFile() || stat.nlink > 1 || !expected.has(relative)) {
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
  for (let index = 1; index < segments.length; index++) {
    const parent = yield* lstatOrNull(NodePath.join(root, ...segments.slice(0, index)));
    if (parent === null) return null;
    if (!parent.isDirectory()) return "a parent folder is a link or a file there";
  }
  const stat = yield* lstatOrNull(NodePath.join(root, ...segments));
  if (stat === null) return null;
  if (!stat.isFile()) return "it is a link or a folder there";
  // An identical file is no change, so sending the same work again is a no-op.
  if (incoming !== null) {
    const [here, there] = yield* Effect.all([
      fileSystemCall("read a file there", () => NodeFSP.readFile(NodePath.join(root, ...segments))),
      fileSystemCall("read an extracted file", () => NodeFSP.readFile(incoming)),
    ]);
    if (here.equals(there)) return null;
  }
  if (local === null) {
    // Outside git nothing records local changes, so only an identical file may be replaced.
    return incoming === null ? null : "it already exists there with other content";
  }
  if (local.changed.has(path)) return "it has local changes there";
  if (!local.tracked.has(path)) return "it is an untracked file there";
  return null;
});

export interface ApplyWorkFilesInput {
  readonly archivePath: string;
  readonly stagingDir: string;
  readonly root: string;
  /** The source's HEAD; null when the source is not a git checkout. */
  readonly head: string | null;
  readonly deletions: ReadonlyArray<string>;
}

/**
 * Applies a received archive to `root`: checks it, extracts it to
 * `stagingDir`, refuses on a HEAD mismatch or any path with local changes,
 * then copies the files in and applies the deletions. The caller owns
 * removing `archivePath` and `stagingDir`.
 */
export const applyWorkFiles = Effect.fn("WorkFiles.apply")(function* (input: ApplyWorkFilesInput) {
  const files = yield* listArchive(input.archivePath, input.root);
  for (const path of input.deletions) {
    if (!isSafeRelativePath(path)) {
      return yield* invalid(`A deletion names an unsafe path: "${path}".`);
    }
  }
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
    NodeFSP.mkdir(input.stagingDir, { recursive: true }),
  );
  const extracted = yield* runProcess("tar", ["-xzf", input.archivePath, "-C", input.stagingDir], {
    cwd: input.stagingDir,
  });
  if (extracted.code !== 0) return yield* invalid("The archive could not be extracted.");
  yield* verifyStaging(input.stagingDir, new Set(files));
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
      NodePath.join(input.stagingDir, ...path.split("/")),
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
  for (const path of files) {
    const destination = NodePath.join(input.root, ...path.split("/"));
    yield* fileSystemCall(`write ${path}`, async () => {
      await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
      await NodeFSP.copyFile(NodePath.join(input.stagingDir, ...path.split("/")), destination);
    });
  }
  let deleted = 0;
  for (const path of input.deletions) {
    const destination = NodePath.join(input.root, ...path.split("/"));
    if ((yield* lstatOrNull(destination)) === null) continue;
    yield* fileSystemCall(`delete ${path}`, () => NodeFSP.rm(destination));
    deleted += 1;
  }
  return { files: files.length, deletions: deleted };
});
