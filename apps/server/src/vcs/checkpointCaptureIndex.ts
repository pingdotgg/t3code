import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Hash from "effect/Hash";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

/**
 * Each checkpoint scope keeps the scratch index of its last capture, so the next capture's
 * `git add` trusts the stat data of files it already hashed instead of rehashing every untracked
 * or modified file. The index lives in the common Git directory, never in the worktree.
 */
const DIRECTORY = "t3-checkpoint-indexes";
// Archived threads stop capturing; their indexes age out instead of waiting for a delete.
const IDLE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_INDEXES = 32;
const LIST_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

const operation = VcsProcess.CHECKPOINT_CAPTURE_OPERATION;

const Meta = Schema.Struct({
  scope: Schema.String,
  cwd: Schema.String,
  tree: Schema.String,
  fingerprint: Schema.String,
});
const MetaJson = Schema.fromJsonString(Meta);
const decodeMeta = Schema.decodeEffect(MetaJson);
const encodeMeta = Schema.encodeEffect(MetaJson);

/** The capture index no longer matches what a rebuilt index would stage; capture again without it. */
export class StaleCaptureIndex extends Schema.TaggedError<StaleCaptureIndex>()(
  "StaleCaptureIndex",
  {},
) {}

/** Refs of one scope differ only in their last segment, the ordinal. */
const scopeOf = (checkpointRef: string) =>
  checkpointRef.slice(0, checkpointRef.lastIndexOf("/") + 1);

const hex = (value: string) => (Hash.string(value) >>> 0).toString(16).padStart(8, "0");

/** Names every capture index of a scope, whatever folder it captured. */
export const scopeDirectoryPrefix = (scopeRefPrefix: string) => `${hex(scopeRefPrefix)}-`;

export const storeRoot = (path: Path.Path, gitCommonDir: string) =>
  path.join(gitCommonDir, DIRECTORY);

/** Removes the capture indexes of scopes whose refs were deleted. */
export const removeForScopes = Effect.fn("GitVcsDriver.checkpoints.removeCaptureIndexes")(
  function* (
    fileSystem: FileSystem.FileSystem,
    path: Path.Path,
    gitCommonDir: string,
    scopeRefPrefixes: Iterable<string>,
  ) {
    const root = storeRoot(path, gitCommonDir);
    const prefixes = [...scopeRefPrefixes].map(scopeDirectoryPrefix);
    const entries = yield* fileSystem.readDirectory(root);
    yield* Effect.forEach(
      entries.filter((entry) => prefixes.some((prefix) => entry.startsWith(prefix))),
      (entry) => fileSystem.remove(path.join(root, entry), { recursive: true, force: true }),
      { discard: true },
    );
  },
  (effect) => Effect.ignore(effect),
);

/**
 * The value Git uses for `key` in `git config --null --get-regexp` output: the last one, as local
 * config follows global and system. Null marks a key written without a value.
 */
export const lastConfigValue = (stdout: string, key: string) => {
  let value: string | null | undefined;
  for (const record of stdout.split("\0")) {
    const newline = record.indexOf("\n");
    if ((newline === -1 ? record : record.slice(0, newline)) === key)
      value = newline === -1 ? null : record.slice(newline + 1);
  }
  return value;
};

/**
 * Git's boolean rules: a valueless key is true, an empty value false, and an integer true unless
 * zero. Integers parse as strtoimax base 0 does (leading space, 0x hex, 0 octal), then a k/m/g unit.
 */
export const gitBool = (value: string | null) => {
  if (value === null) return true;
  if (/^(?:true|yes|on)$/i.test(value)) return true;
  const integer = /^\s*[+-]?(?:0x([\da-f]+)|([1-9]\d*|0[0-7]*))[kmg]?$/i.exec(value);
  return integer !== null && /[1-9a-f]/i.test(integer[1] ?? integer[2]!);
};

const statSignature = (fileSystem: FileSystem.FileSystem, file: string) =>
  fileSystem.stat(file).pipe(
    Effect.map(
      (info) =>
        `${Option.match(info.mtime, { onNone: () => "", onSome: (at) => at.getTime() })}:${info.size}:${Option.getOrElse(info.ino, () => "")}`,
    ),
    Effect.orElseSucceed(() => "-"),
  );

export const make = (
  execute: VcsDriver.VcsDriver["Service"]["execute"],
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
) => {
  const locate = (input: {
    readonly gitCommonDir: string;
    readonly checkpointRef: string;
    readonly cwd: string;
  }) => {
    const scope = scopeOf(input.checkpointRef);
    const directory = path.join(
      storeRoot(path, input.gitCommonDir),
      `${scopeDirectoryPrefix(scope)}${hex(input.cwd)}`,
    );
    return { scope, cwd: input.cwd, directory };
  };
  type Location = ReturnType<typeof locate>;

  /**
   * What decides the blob `git add` records for a file whose stat is unchanged, outside the files
   * a capture stages: conversion config and attribute files above the folder or outside the tree.
   */
  const fingerprint = Effect.fn("GitVcsDriver.checkpoints.captureIndexFingerprint")(
    function* (input: {
      readonly cwd: string;
      readonly config: string;
      readonly gitCommonDir: string;
      readonly topLevel: string;
      readonly prefix: string;
      readonly hostEnv: NodeJS.ProcessEnv;
    }) {
      const { HOME: home, XDG_CONFIG_HOME: xdgConfigHome } = input.hostEnv;
      // Git expands ~, ~user and %(prefix) itself, so only a configured value costs a command.
      const globalAttributes =
        lastConfigValue(input.config, "core.attributesfile") === undefined
          ? xdgConfigHome
            ? path.join(xdgConfigHome, "git", "attributes")
            : home
              ? path.join(home, ".config", "git", "attributes")
              : ""
          : (yield* execute({
              operation,
              cwd: input.cwd,
              args: ["config", "--type=path", "--get", "core.attributesFile"],
              allowNonZeroExit: true,
            })).stdout.replace(/\n$/, "");
      // Files inside the folder are staged, so a change to a tracked or untracked .gitattributes
      // there shows in the tree; an ignored one above it, the root included, does not.
      const parents = [""];
      for (
        let end = input.prefix.indexOf("/");
        end !== -1;
        end = input.prefix.indexOf("/", end + 1)
      ) {
        if (end + 1 < input.prefix.length) parents.push(input.prefix.slice(0, end + 1));
      }
      const signatures = yield* Effect.forEach(
        [
          path.join(input.gitCommonDir, "info", "attributes"),
          // Git reads relative paths after moving to the working-tree root.
          globalAttributes === "" ? "" : path.resolve(input.topLevel, globalAttributes),
          ...parents.map((parent) => path.join(input.topLevel, parent, ".gitattributes")),
        ],
        (file) => (file === "" ? Effect.succeed("-") : statSignature(fileSystem, file)),
      );
      return `${input.config}\0${signatures.join("\0")}`;
    },
  );

  /**
   * Moves the scope's index to `indexFile` and makes it hold exactly what a rebuilt index would
   * before `git add`: HEAD outside the staged pathspec, and inside it every previously captured
   * path that `git add -A` would still stage, except a nested checkout HEAD does not track.
   * Returns the tree it held, or undefined to rebuild.
   */
  const claim = Effect.fn("GitVcsDriver.checkpoints.claimCaptureIndex")(
    function* (input: {
      readonly location: Location;
      readonly fingerprint: string;
      readonly topLevel: string;
      readonly prefix: string;
      readonly excludePaths: ReadonlyArray<string>;
      readonly head: string;
      readonly indexFile: string;
      readonly env: NodeJS.ProcessEnv;
      readonly indexConfig: ReadonlyArray<string>;
    }) {
      const metaFile = path.join(input.location.directory, "meta.json");
      const raw = yield* fileSystem.readFileString(metaFile);
      // Claimed before use: a capture that fails from here on leaves nothing to trust.
      yield* fileSystem.remove(metaFile);
      const meta = yield* decodeMeta(raw);
      // A rename keeps the index's timestamp, which Git's racy-entry check depends on.
      yield* fileSystem.rename(
        path.join(input.location.directory, `index.${meta.tree}`),
        input.indexFile,
      );
      if (
        meta.scope !== input.location.scope ||
        meta.cwd !== input.location.cwd ||
        meta.fingerprint !== input.fingerprint
      ) {
        return undefined;
      }
      const excluded = input.excludePaths.map(
        (entry) => `${input.prefix}${entry.replace(/^\.\//, "").replace(/\/+$/, "")}`,
      );
      if (excluded.some((entry) => entry === input.prefix || /(?:^|\/)\.\.(?:\/|$)/.test(entry))) {
        return undefined;
      }
      const staged = (entryPath: string) =>
        entryPath.startsWith(input.prefix) &&
        !excluded.some((entry) => entryPath === entry || entryPath.startsWith(`${entry}/`));

      const diff = yield* execute({
        operation,
        cwd: input.topLevel,
        args: [
          "diff-tree",
          "-r",
          "-z",
          "--raw",
          "--no-abbrev",
          "--no-renames",
          meta.tree,
          input.head,
        ],
        maxOutputBytes: LIST_MAX_OUTPUT_BYTES,
        outputMode: "error",
      });
      // Records are ":<old mode> <new mode> <old oid> <new oid> <status> NUL <path> NUL".
      const fields = diff.stdout.split("\0");
      const updates: string[] = [];
      const candidates: Array<{ path: string; oid: string }> = [];
      const kept = new Set<string>();
      for (let field = 0; field + 1 < fields.length; field += 2) {
        const [oldMode = "", newMode = "", oldOid = "", newOid = ""] =
          fields[field]!.slice(1).split(" ");
        const entryPath = fields[field + 1]!;
        // U+FFFD marks a name that is not UTF-8 and so cannot be fed back to Git from here.
        if (entryPath.includes("�")) return undefined;
        if (
          !staged(entryPath) ||
          oldMode === "000000" ||
          // A kept gitlink HEAD lacks makes add -A run git status inside that nested checkout.
          (oldMode === "160000" && newMode === "000000")
        ) {
          // HEAD's entry, as a rebuilt index holds it; add -A then decides as it would there.
          updates.push(
            newMode === "000000"
              ? `0 ${oldOid}\t${entryPath}`
              : `${newMode} ${newOid}\t${entryPath}`,
          );
        } else if (newMode === "000000") {
          candidates.push({ path: entryPath, oid: oldOid });
        } else if (oldMode !== "160000") {
          kept.add(oldOid);
        }
      }

      if (candidates.length > 0) {
        // Paths HEAD lacks are untracked to a rebuilt index: add -A skips them once ignored,
        // and stages a directory that became a repository as one gitlink.
        // ./ avoids leading : pathspec magic; check-ignore rejects --literal-pathspecs.
        const stdin = candidates.map((entry) => `./${entry.path}\0`).join("");
        const ignored = yield* execute({
          operation,
          cwd: input.topLevel,
          args: ["check-ignore", "--no-index", "-z", "--stdin"],
          stdin,
          allowNonZeroExit: true,
          maxOutputBytes: Buffer.byteLength(stdin),
          outputMode: "error",
        });
        if (ignored.exitCode > 1) return undefined;
        const ignoredPaths = new Set(
          ignored.stdout.split("\0").map((entryPath) => entryPath.replace(/^\.\//, "")),
        );
        const directories = new Set<string>();
        for (const entry of candidates) {
          for (
            let end = entry.path.lastIndexOf("/");
            end > 0 && !directories.has(entry.path.slice(0, end));
            end = entry.path.lastIndexOf("/", end - 1)
          ) {
            directories.add(entry.path.slice(0, end));
          }
        }
        const repositories = new Set<string>();
        yield* Effect.forEach(
          directories,
          (directory) =>
            fileSystem.exists(path.join(input.topLevel, directory, ".git")).pipe(
              Effect.map((exists) => {
                if (exists) repositories.add(directory);
              }),
            ),
          { concurrency: 64, discard: true },
        );
        const insideRepository = (entryPath: string) => {
          for (
            let end = entryPath.lastIndexOf("/");
            end > 0;
            end = entryPath.lastIndexOf("/", end - 1)
          ) {
            if (repositories.has(entryPath.slice(0, end))) return true;
          }
          return false;
        };
        for (const entry of candidates) {
          if (ignoredPaths.has(entry.path) || insideRepository(entry.path)) {
            updates.push(`0 ${entry.oid}\t${entry.path}`);
          } else {
            kept.add(entry.oid);
          }
        }
      }

      if (kept.size > 0) {
        // Only refs keep objects from gc; a blob whose checkpoint was deleted may be gone.
        const objects = yield* execute({
          operation,
          cwd: input.topLevel,
          args: ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
          stdin: `${[...kept].join("\n")}\n`,
          maxOutputBytes: kept.size * 128,
          outputMode: "error",
        });
        const present = new Set(objects.stdout.split("\n"));
        for (const oid of kept) if (!present.has(`${oid} blob`)) return undefined;
      }

      if (updates.length > 0) {
        // Restore the timestamp Git's racy check reads; update-index advances it.
        const { mtime } = yield* fileSystem.stat(input.indexFile);
        const indexTime = Option.isSome(mtime) ? Math.floor(mtime.value.getTime() / 1000) : 0;
        if (indexTime <= 0) return undefined;
        yield* execute({
          operation,
          cwd: input.topLevel,
          args: [...input.indexConfig, "update-index", "-z", "--index-info"],
          stdin: `${updates.join("\0")}\0`,
          env: input.env,
        });
        yield* fileSystem.utimes(input.indexFile, indexTime, indexTime);
      }
      return meta.tree;
    },
    Effect.orElseSucceed(() => undefined),
  );

  /** Throws a capture's index away when `git add` may have trusted stale conversion rules. */
  const attributesChanged = (input: {
    readonly cwd: string;
    readonly previousTree: string;
    readonly tree: string;
    /** The capture's environment, whose private object store holds the new tree. */
    readonly env: NodeJS.ProcessEnv;
  }) =>
    execute({
      operation,
      cwd: input.cwd,
      env: input.env,
      args: [
        "diff-tree",
        "-r",
        "-z",
        "--name-only",
        "--no-renames",
        input.previousTree,
        input.tree,
        "--",
        ":(top,glob)**/.gitattributes",
      ],
      maxOutputBytes: 1,
      outputMode: "truncate",
    }).pipe(Effect.map((result) => result.stdout.length > 0));

  /** Keeps a published capture's index, hard-linked before anything else rewrote it, for the next. */
  const save = Effect.fn("GitVcsDriver.checkpoints.saveCaptureIndex")(
    function* (input: {
      readonly location: Location;
      readonly indexFile: string;
      readonly tree: string;
      readonly fingerprint: string;
    }) {
      const { directory } = input.location;
      const root = path.dirname(directory);
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      // Named by its tree, so a racing save can never pair one capture's index with another's meta.
      const indexName = `index.${input.tree}`;
      yield* fileSystem.rename(input.indexFile, path.join(directory, indexName));
      const metaFile = path.join(directory, "meta.json");
      yield* fileSystem.writeFileString(
        `${metaFile}.tmp`,
        yield* encodeMeta({
          scope: input.location.scope,
          cwd: input.location.cwd,
          tree: input.tree,
          fingerprint: input.fingerprint,
        }),
      );
      yield* fileSystem.rename(`${metaFile}.tmp`, metaFile);
      yield* Effect.forEach(
        (yield* fileSystem.readDirectory(directory)).filter(
          (entry) => entry.startsWith("index.") && entry !== indexName,
        ),
        (entry) => fileSystem.remove(path.join(directory, entry), { force: true }),
        { discard: true },
      );

      const now = yield* Clock.currentTimeMillis;
      const others = yield* Effect.forEach(
        (yield* fileSystem.readDirectory(root)).filter(
          (entry) => path.join(root, entry) !== directory,
        ),
        (entry) =>
          fileSystem.stat(path.join(root, entry)).pipe(
            Effect.map((info) => ({
              entry,
              at: Option.match(info.mtime, { onNone: () => 0, onSome: (at) => at.getTime() }),
            })),
            Effect.orElseSucceed(() => ({ entry, at: 0 })),
          ),
      );
      const stale = others
        .toSorted((left, right) => right.at - left.at)
        .filter((other, index) => index >= MAX_INDEXES - 1 || now - other.at > IDLE_MS);
      yield* Effect.forEach(
        stale,
        ({ entry }) =>
          fileSystem
            .remove(path.join(root, entry), { recursive: true, force: true })
            .pipe(Effect.ignore),
        { discard: true },
      );
    },
    (effect, input) =>
      effect.pipe(
        Effect.ignore,
        Effect.ensuring(fileSystem.remove(input.indexFile, { force: true }).pipe(Effect.ignore)),
      ),
  );

  return { locate, fingerprint, claim, attributesChanged, save };
};
