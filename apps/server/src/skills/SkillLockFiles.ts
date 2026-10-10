/**
 * SkillLockFiles - the `skills` CLI's records of where an installed skill came from.
 *
 * The CLI keeps one record per skill: a global lock (v3) for skills in the home folder and
 * `skills-lock.json` (v1) in a project. T3 Code reads them to group skills by their source, and
 * rewrites them only when a skill moves between a project and Global, so the record goes with it.
 * The format and the CLI's own handling follow vercel-labs/skills v1.7.0 (14cf84aa), `src/skill-lock.ts`
 * and `src/local-lock.ts`:
 * - The CLI treats a file it can't parse, or one with a version older than it knows, as empty, and
 *   its next write replaces the file with one entry. So a lock that doesn't parse, or whose version
 *   isn't the one this module writes, is never written here (a newer version is still read).
 * - The global lock is at `$XDG_STATE_HOME/skills/.skill-lock.json` when that is set, else
 *   `~/.agents/.skill-lock.json`; it is `JSON.stringify(lock, null, 2)` with no trailing newline.
 *   The project lock has its skills sorted by name and ends with a newline. A rewrite keeps the
 *   indent, the trailing newline and the order the file already had.
 * - A global entry's `skillFolderHash` is the GitHub tree SHA of the skill's folder. An empty one is
 *   the CLI's "not version-tracked" value, so the CLI never overwrites such a skill. A project
 *   entry's `computedHash` is SHA-256 over the folder's files, `computeSkillFolderHash` in the CLI.
 *   Because only the CLI's own download can say what `computedHash` the upstream folder has, a
 *   record is moved to a project only when the folder is byte for byte that tree (its git tree SHA
 *   is the recorded `skillFolderHash`); otherwise it is dropped.
 *
 * Nothing here is cached; each call reads the files as they are.
 *
 * @module SkillLockFiles
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off - the hashes have to match the skills CLI's own SHA-1 and SHA-256 over buffers, computed synchronously.
import * as NodeCrypto from "node:crypto";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";

const GLOBAL_LOCK_VERSION = 3;
const PROJECT_LOCK_VERSION = 1;
const GLOBAL_LOCK_FILE = ".skill-lock.json";
const PROJECT_LOCK_FILE = "skills-lock.json";
const MAX_LOCK_BYTES = 4 * 1024 * 1024;
const SOURCE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** Folders the CLI leaves out of `computedHash`. */
const HASH_SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);
const MAX_HASHED_FILES = 500;
const MAX_HASHED_BYTES = 16 * 1024 * 1024;

/** The lock a skill's record lives in. */
export type LockScope =
  | { readonly kind: "global" }
  | { readonly kind: "project"; readonly root: string };

type Json = Record<string, unknown>;

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface FoundLock {
  readonly _tag: "Found";
  readonly path: string;
  readonly version: number;
  readonly data: Json & { skills: Json };
  /** What the file used to indent with, and whether it ended with a newline. */
  readonly indent: string;
  readonly trailingNewline: boolean;
  /** The skills were sorted by name, as the CLI writes a project lock. */
  readonly sorted: boolean;
}

type ReadLock = { readonly _tag: "Missing" } | { readonly _tag: "Unusable" } | FoundLock;

/** The global lock's path, which follows `XDG_STATE_HOME` as the CLI does. */
const globalLockPath = (
  path: Path.Path,
  input: { readonly environment: NodeJS.ProcessEnv; readonly home: string },
) => {
  const state = input.environment.XDG_STATE_HOME;
  return state
    ? path.join(state, "skills", GLOBAL_LOCK_FILE)
    : path.join(input.home, ".agents", GLOBAL_LOCK_FILE);
};

const lockPathOf = (
  path: Path.Path,
  scope: LockScope,
  context: { readonly environment: NodeJS.ProcessEnv; readonly home: string },
) =>
  scope.kind === "global"
    ? globalLockPath(path, context)
    : path.join(scope.root, PROJECT_LOCK_FILE);

/** The version a lock of this kind is written with. */
const writtenVersion = (scope: LockScope) =>
  scope.kind === "global" ? GLOBAL_LOCK_VERSION : PROJECT_LOCK_VERSION;

const isSorted = (names: readonly string[]) =>
  names.every((name, index) => index === 0 || (names[index - 1] ?? "") <= name);

const readLock = Effect.fnUntraced(function* (file: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* fileSystem.stat(file).pipe(
    Effect.map((value) => ({ _tag: "Exists" as const, value })),
    Effect.catchTags({
      PlatformError: (error) =>
        Effect.succeed(
          error.reason._tag === "NotFound"
            ? ({ _tag: "Missing" } as const)
            : ({ _tag: "Unusable" } as const),
        ),
    }),
  );
  if (info._tag !== "Exists") return info satisfies ReadLock;
  if (info.value.type !== "File" || Number(info.value.size) > MAX_LOCK_BYTES) {
    return { _tag: "Unusable" } as const satisfies ReadLock;
  }
  const text = yield* fileSystem.readFileString(file).pipe(Effect.orElseSucceed(() => undefined));
  if (text === undefined) return { _tag: "Unusable" } as const satisfies ReadLock;
  const parsed = Option.getOrUndefined(decodeJson(text));
  if (!isRecord(parsed) || typeof parsed.version !== "number" || !isRecord(parsed.skills)) {
    return { _tag: "Unusable" } as const satisfies ReadLock;
  }
  return {
    _tag: "Found",
    path: file,
    version: parsed.version,
    data: parsed as FoundLock["data"],
    indent: /^([ \t]+)"/m.exec(text)?.[1] ?? "  ",
    trailingNewline: text.endsWith("\n"),
    sorted: isSorted(Object.keys(parsed.skills)),
  } satisfies ReadLock;
});

const sourceOf = (entry: unknown) =>
  isRecord(entry) &&
  entry.sourceType === "github" &&
  typeof entry.source === "string" &&
  SOURCE.test(entry.source)
    ? entry.source
    : undefined;

/**
 * The `owner/repo` each skill was installed from, by skill name, for GitHub sources. The global
 * lock answers for Global skills and `projectRoot`'s lock for that project's. A lock that can't be
 * read says nothing.
 */
export const readSources = Effect.fn("SkillLockFiles.readSources")(function* (input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly home: string;
  readonly projectRoot?: string | undefined;
}) {
  const path = yield* Path.Path;
  const sourcesIn = Effect.fnUntraced(function* (scope: LockScope, oldest: number) {
    const lock = yield* readLock(lockPathOf(path, scope, input));
    const sources = new Map<string, string>();
    if (lock._tag !== "Found" || lock.version < oldest) return sources;
    for (const [name, entry] of Object.entries(lock.data.skills)) {
      const source = sourceOf(entry);
      if (source !== undefined) sources.set(name, source);
    }
    return sources;
  });
  return {
    global: yield* sourcesIn({ kind: "global" }, GLOBAL_LOCK_VERSION),
    project:
      input.projectRoot === undefined
        ? new Map<string, string>()
        : yield* sourcesIn({ kind: "project", root: input.projectRoot }, PROJECT_LOCK_VERSION),
  };
});

/** One regular file in a skill's folder, or a link in it. */
interface HashedEntry {
  readonly relative: string;
  readonly kind: "file" | "link";
  readonly bytes: Uint8Array;
  readonly executable: boolean;
}

/** Everything in a skill's folder that the hashes look at, or undefined when it can't be hashed. */
const readFolder = Effect.fnUntraced(function* (root: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries: HashedEntry[] = [];
  let total = 0;
  const pending = [""];
  for (let folder = pending.shift(); folder !== undefined; folder = pending.shift()) {
    const names = yield* fileSystem
      .readDirectory(path.join(root, folder))
      .pipe(Effect.orElseSucceed(() => undefined));
    if (names === undefined) return undefined;
    for (const name of names) {
      const relative = folder === "" ? name : `${folder}/${name}`;
      const absolute = path.join(root, relative);
      const target = yield* fileSystem.readLink(absolute).pipe(
        Effect.map((value): string | undefined => value),
        Effect.orElseSucceed(() => undefined),
      );
      if (target !== undefined) {
        entries.push({
          relative,
          kind: "link",
          bytes: new TextEncoder().encode(target),
          executable: false,
        });
        continue;
      }
      const info = yield* fileSystem.stat(absolute).pipe(Effect.orElseSucceed(() => undefined));
      if (info === undefined) return undefined;
      if (info.type === "Directory") {
        pending.push(relative);
        continue;
      }
      if (info.type !== "File") return undefined;
      total += Number(info.size);
      if (entries.length >= MAX_HASHED_FILES || total > MAX_HASHED_BYTES) return undefined;
      const bytes = yield* fileSystem
        .readFile(absolute)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (bytes === undefined) return undefined;
      entries.push({ relative, kind: "file", bytes, executable: (info.mode & 0o111) !== 0 });
    }
  }
  return entries;
});

const sha1 = (...parts: ReadonlyArray<Uint8Array | string>) => {
  const hash = NodeCrypto.createHash("sha1");
  for (const part of parts) hash.update(part);
  return hash.digest();
};

interface TreeNode {
  readonly files: Map<string, { readonly mode: string; readonly sha: Buffer }>;
  readonly folders: Map<string, TreeNode>;
}

/** The git tree SHA of the entries, the way GitHub reports a folder's `skillFolderHash`. */
const gitTreeSha = (entries: readonly HashedEntry[]) => {
  const root: TreeNode = { files: new Map(), folders: new Map() };
  for (const entry of entries) {
    const parts = entry.relative.split("/");
    const name = parts.pop() ?? "";
    let node = root;
    for (const part of parts) {
      const next = node.folders.get(part) ?? { files: new Map(), folders: new Map() };
      node.folders.set(part, next);
      node = next;
    }
    const mode = entry.kind === "link" ? "120000" : entry.executable ? "100755" : "100644";
    node.files.set(name, {
      mode,
      sha: sha1(`blob ${entry.bytes.byteLength}\0`, entry.bytes),
    });
  }
  const encode = (node: TreeNode): Buffer | undefined => {
    const items: Array<{ readonly key: string; readonly body: Buffer }> = [];
    for (const [name, file] of node.files) {
      items.push({
        key: name,
        body: Buffer.concat([Buffer.from(`${file.mode} ${name}\0`), file.sha]),
      });
    }
    for (const [name, folder] of node.folders) {
      const content = encode(folder);
      if (content === undefined) continue;
      items.push({
        // Git sorts a folder as if its name ended with a slash.
        key: `${name}/`,
        body: Buffer.concat([
          Buffer.from(`40000 ${name}\0`),
          sha1(`tree ${content.length}\0`, content),
        ]),
      });
    }
    if (items.length === 0) return undefined;
    items.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
    return Buffer.concat(items.map((item) => item.body));
  };
  const content = encode(root) ?? Buffer.alloc(0);
  return sha1(`tree ${content.length}\0`, content).toString("hex");
};

/** The CLI's `computeSkillFolderHash`: SHA-256 over each file's path and bytes, sorted by path. */
const computedHash = (entries: readonly HashedEntry[]) => {
  const hash = NodeCrypto.createHash("sha256");
  const files = entries
    .filter(
      (entry) =>
        entry.kind === "file" &&
        !entry.relative
          .split("/")
          .slice(0, -1)
          .some((part) => HASH_SKIPPED_DIRECTORIES.has(part)),
    )
    .toSorted((a, b) => a.relative.localeCompare(b.relative));
  for (const file of files) {
    hash.update(file.relative);
    hash.update(file.bytes);
  }
  return hash.digest("hex");
};

/** What the CLI hashes a skill's folder to, for a project lock; undefined if it can't be read. */
export const hashSkillFolder = Effect.fn("SkillLockFiles.hashSkillFolder")(function* (
  folder: string,
) {
  const entries = yield* readFolder(folder);
  return entries === undefined
    ? undefined
    : { treeSha: gitTreeSha(entries), computedHash: computedHash(entries) };
});

const DEFAULT_GITHUB_URL = (source: string) => `https://github.com/${source}.git`;

/**
 * The record as the other lock keeps it, or undefined when it can't be carried over. A path-based
 * source (`local`, `node_modules`) means nothing in another place, and a global record needs the
 * URL the CLI reinstalls from.
 */
const convertRecord = (
  entry: unknown,
  from: LockScope,
  to: LockScope,
  folderHashes: { readonly treeSha: string; readonly computedHash: string } | undefined,
  now: string,
): Json | undefined => {
  if (
    !isRecord(entry) ||
    typeof entry.source !== "string" ||
    typeof entry.sourceType !== "string"
  ) {
    return undefined;
  }
  if (entry.sourceType === "local" || entry.sourceType === "node_modules") return undefined;
  const optional = (key: string) => (typeof entry[key] === "string" ? { [key]: entry[key] } : {});
  if (from.kind === "project" && to.kind === "project") return { ...entry };
  if (from.kind === "project") {
    const sourceUrl =
      typeof entry.sourceUrl === "string"
        ? entry.sourceUrl
        : entry.sourceType === "github"
          ? DEFAULT_GITHUB_URL(entry.source)
          : undefined;
    if (sourceUrl === undefined) return undefined;
    return {
      source: entry.source,
      sourceType: entry.sourceType,
      sourceUrl,
      ...optional("ref"),
      ...optional("skillPath"),
      // The CLI's "not version-tracked" value, so it never overwrites the skill.
      skillFolderHash: "",
      installedAt: now,
      updatedAt: now,
      ...optional("wellKnownDigest"),
    };
  }
  // Global to a project: only a folder that is exactly the recorded tree has a known hash.
  if (
    entry.sourceType !== "github" ||
    typeof entry.skillFolderHash !== "string" ||
    entry.skillFolderHash === "" ||
    folderHashes === undefined ||
    folderHashes.treeSha !== entry.skillFolderHash
  ) {
    return undefined;
  }
  return {
    source: entry.source,
    ...(typeof entry.sourceUrl === "string" && entry.sourceUrl !== DEFAULT_GITHUB_URL(entry.source)
      ? { sourceUrl: entry.sourceUrl }
      : {}),
    ...optional("ref"),
    sourceType: entry.sourceType,
    ...optional("skillPath"),
    computedHash: folderHashes.computedHash,
    ...optional("wellKnownDigest"),
  };
};

const render = (lock: FoundLock, skills: Json, scope: LockScope) => {
  const ordered =
    scope.kind === "project" && lock.sorted
      ? Object.fromEntries(
          Object.entries(skills).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : skills;
  const text = JSON.stringify({ ...lock.data, skills: ordered }, null, lock.indent);
  return lock.trailingNewline ? `${text}\n` : text;
};

export type MoveRecordResult =
  /** The record is in the other lock and out of this one. */
  | "moved"
  /** The record couldn't be carried over, so it is out of this lock and in no other. */
  | "dropped"
  /** The skill has no record here. */
  | "none"
  /** A lock couldn't be read or written safely; no lock was changed. */
  | "untouched";

/**
 * Takes a skill's record out of `from`'s lock and puts it into `to`'s, in the shape that lock
 * keeps. A lock that doesn't parse, or has a version this module doesn't write, is left exactly as
 * it is, and then the other lock is left alone too so a record is never lost. `folder` is where
 * the skill's files are now.
 */
export const moveRecord = Effect.fn("SkillLockFiles.moveRecord")(function* (input: {
  readonly name: string;
  readonly from: LockScope;
  readonly to: LockScope;
  readonly folder: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly home: string;
}) {
  const path = yield* Path.Path;
  const source = yield* readLock(lockPathOf(path, input.from, input));
  if (source._tag !== "Found" || !(input.name in source.data.skills)) {
    return (source._tag === "Unusable" ? "untouched" : "none") satisfies MoveRecordResult;
  }
  if (source.version !== writtenVersion(input.from)) return "untouched" as const;

  const target = yield* readLock(lockPathOf(path, input.to, input));
  if (target._tag === "Unusable") return "untouched" as const;
  if (target._tag === "Found" && target.version !== writtenVersion(input.to)) {
    return "untouched" as const;
  }

  const now = DateTime.formatIso(yield* DateTime.now);
  const hashes =
    input.from.kind === "global" && input.to.kind === "project"
      ? yield* hashSkillFolder(input.folder)
      : undefined;
  const converted = convertRecord(
    source.data.skills[input.name],
    input.from,
    input.to,
    hashes,
    now,
  );

  if (converted !== undefined) {
    const fresh: FoundLock = {
      _tag: "Found",
      path: lockPathOf(path, input.to, input),
      version: writtenVersion(input.to),
      data:
        input.to.kind === "global"
          ? { version: GLOBAL_LOCK_VERSION, skills: {}, dismissed: {} }
          : { version: PROJECT_LOCK_VERSION, skills: {} },
      indent: "  ",
      trailingNewline: input.to.kind === "project",
      sorted: true,
    };
    const destination = target._tag === "Found" ? target : fresh;
    yield* writeFileStringAtomically({
      filePath: destination.path,
      contents: render(
        destination,
        { ...destination.data.skills, [input.name]: converted },
        input.to,
      ),
    });
  }

  const { [input.name]: _removed, ...rest } = source.data.skills;
  yield* writeFileStringAtomically({
    filePath: source.path,
    contents: render(source, rest, input.from),
  });
  return (converted === undefined ? "dropped" : "moved") satisfies MoveRecordResult;
});
