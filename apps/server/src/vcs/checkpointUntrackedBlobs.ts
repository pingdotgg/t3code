// @effect-diagnostics nodeBuiltinImport:off - Comparing a file with its last capture needs bigint lstat, which FileSystem lacks.
import * as NodeFSP from "node:fs/promises";

import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import type * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

/** An untracked file's blob from the last capture, with everything that decided its content. */
interface UntrackedBlob {
  readonly path: string;
  readonly mode: string;
  readonly oid: string;
  readonly size: bigint;
  readonly stat: string;
  readonly attributes: string;
}

interface Snapshot {
  readonly topLevel: string;
  readonly head: string;
  readonly config: string;
  readonly blobs: ReadonlyArray<UntrackedBlob>;
  /** Files hashed without a reading of their conversion state from before staging. */
  readonly pending: ReadonlyArray<string>;
}

/** The conversion state read before staging; a blob is remembered only if it reads the same after. */
interface ConversionState {
  readonly config: string;
  readonly attributes: ReadonlyMap<string, string | undefined>;
}

export const NOTHING: {
  readonly reused: ReadonlyArray<UntrackedBlob>;
  readonly before: ConversionState | undefined;
} = { reused: [], before: undefined };

// Every attribute convert_to_git reads; a blob is reused only while all of them are unchanged.
const CONVERSION_ATTRIBUTES = [
  "text",
  "eol",
  "crlf",
  "ident",
  "working-tree-encoding",
  "filter",
] as const;
const MAX_BLOBS = 20_000;
// Below this, hashing the files costs less than the Git processes that check them.
const MIN_TOTAL_BYTES = 16n * 1024n * 1024n;
// A capture that staged faster than this and reused nothing has nothing worth another Git process.
const MIN_STAGING_MS = 100;
// A file must have been left alone for this long before the capture, so an edit that lands
// while Git hashes it cannot hide inside one timestamp tick (two seconds on FAT).
const SETTLED_MS = 3_000;
const MAX_WORKSPACES = 64;
const STAT_BATCH = 512;
const LIST_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

const operation = VcsProcess.CHECKPOINT_CAPTURE_OPERATION;

const lstatAll = (root: string, paths: ReadonlyArray<string>) =>
  Effect.promise(async () => {
    const stats: Array<
      { stat: string; size: bigint; changedNs: bigint; regular: boolean } | undefined
    > = [];
    for (let start = 0; start < paths.length; start += STAT_BATCH) {
      const batch = await Promise.all(
        paths.slice(start, start + STAT_BATCH).map((entryPath) =>
          NodeFSP.lstat(`${root}/${entryPath}`, { bigint: true }).then(
            (stat) => ({
              stat: `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
              size: stat.size,
              changedNs: stat.mtimeNs > stat.ctimeNs ? stat.mtimeNs : stat.ctimeNs,
              regular: stat.isFile(),
            }),
            () => undefined,
          ),
        ),
      );
      stats.push(...batch);
    }
    return stats;
  });

/**
 * Lets a capture skip rehashing untracked files that have not changed since the last capture of
 * the same workspace. A blob is reused only when a fresh `git add` would produce the same one:
 * same file stat, same conversion attributes and config, still not ignored, still not tracked.
 */
export const make = (
  execute: VcsDriver.VcsDriver["Service"]["execute"],
  fileSystem: FileSystem.FileSystem,
) => {
  const snapshots = new Map<string, Snapshot>();

  // Worktree files only: an index copy of a deleted .gitattributes applies or not by staging order.
  const readAttributes = Effect.fn("GitVcsDriver.checkpoints.readConversionAttributes")(function* (
    topLevel: string,
    env: NodeJS.ProcessEnv,
    paths: ReadonlyArray<string>,
  ) {
    if (paths.length === 0) return [];
    const stdin = `${paths.join("\0")}\0`;
    const result = yield* execute({
      operation,
      cwd: topLevel,
      args: ["check-attr", "-z", "--stdin", ...CONVERSION_ATTRIBUTES],
      stdin,
      env: { ...env, GIT_INDEX_FILE: `${env.GIT_INDEX_FILE}.none` },
      maxOutputBytes:
        CONVERSION_ATTRIBUTES.length * (Buffer.byteLength(stdin) + paths.length * 256),
      outputMode: "error",
    });
    // Records are "<path> NUL <attribute> NUL <value> NUL", one per attribute, in input order.
    const fields = result.stdout.split("\0");
    return paths.map((entryPath, index) => {
      const values: string[] = [];
      for (let attribute = 0; attribute < CONVERSION_ATTRIBUTES.length; attribute++) {
        const field = (index * CONVERSION_ATTRIBUTES.length + attribute) * 3;
        if (fields[field] !== entryPath || fields[field + 2] === undefined) return undefined;
        values.push(fields[field + 2]!);
      }
      return values.join("\0");
    });
  });

  // Config that changes the blob or mode `git add` records for an unchanged file.
  const readConfig = (cwd: string) =>
    execute({
      operation,
      cwd,
      args: [
        "config",
        "--null",
        "--get-regexp",
        "^(core\\.(autocrlf|eol|filemode)|filter\\.(unspecified|unset)\\..*)$",
      ],
      allowNonZeroExit: true,
    }).pipe(Effect.map((result) => `${result.exitCode}\0${result.stdout}`));

  /**
   * Finds directories whose .gitattributes may have changed while Git hashed: a present file
   * touched since just before the capture, or a missing one in a directory touched since then.
   * Reading attributes before and after staging cannot see a change that was undone in between.
   */
  const changingAttributeDirectories = Effect.fnUntraced(function* (
    topLevel: string,
    paths: ReadonlyArray<string>,
    settledNs: bigint,
  ) {
    const directories = new Set<string>(paths.length === 0 ? [] : [""]);
    for (const entryPath of paths) {
      for (
        let end = entryPath.lastIndexOf("/");
        end > 0 && !directories.has(entryPath.slice(0, end + 1));
        end = entryPath.lastIndexOf("/", end - 1)
      ) {
        directories.add(entryPath.slice(0, end + 1));
      }
    }
    const list = [...directories];
    const [files, parents] = yield* Effect.all([
      lstatAll(
        topLevel,
        list.map((directory) => `${directory}.gitattributes`),
      ),
      lstatAll(topLevel, list),
    ]);
    const changing = new Set(
      list.filter((_, index) => {
        const changedNs = (files[index] ?? parents[index])?.changedNs;
        return changedNs === undefined || changedNs >= settledNs;
      }),
    );
    return (entryPath: string) => {
      if (changing.has("")) return true;
      for (
        let end = entryPath.lastIndexOf("/");
        end > 0;
        end = entryPath.lastIndexOf("/", end - 1)
      ) {
        if (changing.has(entryPath.slice(0, end + 1))) return true;
      }
      return false;
    };
  });

  /**
   * Adds the still-valid blobs to the scratch index, flagged so `git add` does not read their
   * files. The index must hold exactly HEAD's paths. Returns the blobs it added, and the
   * conversion state of every file this capture may remember, read before any of them is hashed.
   */
  const reuse = Effect.fn("GitVcsDriver.checkpoints.reuseUntrackedBlobs")(
    function* (input: {
      readonly cwd: string;
      readonly topLevel: string;
      readonly head: string;
      readonly env: NodeJS.ProcessEnv;
      readonly indexConfig: ReadonlyArray<string>;
    }) {
      const snapshot = snapshots.get(input.cwd);
      // A capture that fails after this point hashes everything once more, then remembers again.
      snapshots.delete(input.cwd);
      if (snapshot === undefined || snapshot.topLevel !== input.topLevel) return NOTHING;
      let blobs = snapshot.blobs;
      if (snapshot.head !== input.head) {
        // A path HEAD now tracks, or one below a path it changed, is no longer untracked.
        const moved = yield* execute({
          operation,
          cwd: input.cwd,
          args: ["diff-tree", "-r", "-z", "--name-only", "--no-renames", snapshot.head, input.head],
          maxOutputBytes: LIST_MAX_OUTPUT_BYTES,
          outputMode: "error",
        });
        const changed = new Set(moved.stdout.split("\0"));
        blobs = blobs.filter((blob) => {
          for (let end = blob.path.length; end > 0; end = blob.path.lastIndexOf("/", end - 1)) {
            if (changed.has(blob.path.slice(0, end))) return false;
          }
          return true;
        });
      }
      const stats = yield* lstatAll(
        input.topLevel,
        blobs.map((blob) => blob.path),
      );
      blobs = blobs.filter((blob, index) => stats[index]?.stat === blob.stat);
      // Git stages a directory that became a repository as one gitlink, not as its files.
      const directories = new Set<string>();
      for (const blob of blobs) {
        for (
          let end = blob.path.lastIndexOf("/");
          end > 0 && !directories.has(blob.path.slice(0, end));
          end = blob.path.lastIndexOf("/", end - 1)
        ) {
          directories.add(blob.path.slice(0, end));
        }
      }
      const directoryList = [...directories];
      const repositories = yield* lstatAll(
        input.topLevel,
        directoryList.map((directory) => `${directory}/.git`),
      );
      const nested = directoryList.filter((_, index) => repositories[index] !== undefined);
      if (nested.length > 0) {
        blobs = blobs.filter(
          (blob) => !nested.some((directory) => blob.path.startsWith(`${directory}/`)),
        );
      }
      const paths = [...blobs.map((blob) => blob.path), ...snapshot.pending];
      if (paths.length === 0) return NOTHING;
      const unchecked = Effect.succeed({ exitCode: 1, stdout: "" });
      // ./ avoids leading : pathspec magic; check-ignore rejects --literal-pathspecs.
      const stdin = blobs.map((blob) => `./${blob.path}\0`).join("");
      const [config, attributes, ignored, objects] = yield* Effect.all(
        [
          readConfig(input.cwd),
          readAttributes(input.topLevel, input.env, paths),
          // Without --no-index this reports only untracked paths, which these are in this index.
          blobs.length === 0
            ? unchecked
            : execute({
                operation,
                cwd: input.topLevel,
                args: [...input.indexConfig, "check-ignore", "-z", "--stdin"],
                stdin,
                env: input.env,
                allowNonZeroExit: true,
                maxOutputBytes: Buffer.byteLength(stdin),
                outputMode: "error",
              }),
          // Blobs of deleted checkpoints can be pruned while this process still remembers them.
          blobs.length === 0
            ? unchecked
            : execute({
                operation,
                cwd: input.cwd,
                args: ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
                stdin: `${[...new Set(blobs.map((blob) => blob.oid))].join("\n")}\n`,
                maxOutputBytes: blobs.length * 128,
                outputMode: "error",
              }),
        ],
        { concurrency: "unbounded" },
      );
      const before: ConversionState = {
        config,
        attributes: new Map(paths.map((entryPath, index) => [entryPath, attributes[index]])),
      };
      if (config !== snapshot.config || ignored.exitCode > 1) return { reused: [], before };
      const ignoredPaths = new Set(
        ignored.stdout.split("\0").map((entryPath) => entryPath.replace(/^\.\//, "")),
      );
      const present = new Set(objects.stdout.split("\n"));
      blobs = blobs.filter(
        (blob, index) =>
          attributes[index] === blob.attributes &&
          !ignoredPaths.has(blob.path) &&
          present.has(`${blob.oid} blob`),
      );
      if (blobs.length === 0) return { reused: [], before };

      const indexFile = input.env.GIT_INDEX_FILE!;
      const { mtime } = yield* fileSystem.stat(indexFile);
      if (Option.isNone(mtime)) return { reused: [], before };
      yield* execute({
        operation,
        cwd: input.cwd,
        // core.ignorestat marks the new entries assume-unchanged, so git add trusts them as they are.
        args: [
          ...input.indexConfig,
          "-c",
          "core.ignorestat=true",
          "update-index",
          "-z",
          "--index-info",
        ],
        stdin: blobs.map((blob) => `${blob.mode} ${blob.oid}\t${blob.path}\0`).join(""),
        env: input.env,
      });
      // Tracked entries are racy against the index's old timestamp, not this rewrite's.
      const indexTime = Math.floor(mtime.value.getTime() / 1000);
      yield* fileSystem.utimes(indexFile, indexTime, indexTime);
      return { reused: blobs, before };
    },
    Effect.orElseSucceed(() => NOTHING),
  );

  /** Records the untracked files the published checkpoint `tree` holds, for the next capture. */
  const remember = Effect.fn("GitVcsDriver.checkpoints.rememberUntrackedBlobs")(
    function* (input: {
      readonly cwd: string;
      readonly topLevel: string;
      readonly head: string;
      readonly tree: string;
      readonly env: NodeJS.ProcessEnv;
      readonly startedAt: number;
      readonly stagingMs: number;
      readonly reused: ReadonlyArray<UntrackedBlob>;
      readonly before: ConversionState | undefined;
    }) {
      if (input.reused.length === 0 && input.stagingMs < MIN_STAGING_MS) return;
      const listed = yield* execute({
        operation,
        cwd: input.cwd,
        args: [
          "diff-tree",
          "-r",
          "-z",
          "--raw",
          "--no-abbrev",
          "--no-renames",
          "--diff-filter=AD",
          input.head,
          input.tree,
        ],
        maxOutputBytes: LIST_MAX_OUTPUT_BYTES,
        outputMode: "error",
      });
      const reused = new Map(input.reused.map((blob) => [blob.path, blob]));
      const kept: UntrackedBlob[] = [];
      const added: Array<{ path: string; mode: string; oid: string }> = [];
      // Records are ":<old mode> <new mode> <old oid> <new oid> <status> NUL <path> NUL".
      const fields = listed.stdout.split("\0");
      for (let field = 0; field + 1 < fields.length; field += 2) {
        const [, mode = "", , oid = "", status] = fields[field]!.split(" ");
        const entryPath = fields[field + 1]!;
        if (status === "D") {
          // Git may still apply a deleted .gitattributes from the index, depending on staging order.
          if (entryPath === ".gitattributes" || entryPath.endsWith("/.gitattributes")) return;
          continue;
        }
        // U+FFFD marks a name that is not UTF-8 and so cannot be addressed from here.
        if ((mode !== "100644" && mode !== "100755") || entryPath.includes("\uFFFD")) continue;
        const previous = reused.get(entryPath);
        if (previous !== undefined && previous.oid === oid && previous.mode === mode) {
          kept.push(previous);
        } else {
          added.push({ path: entryPath, mode, oid });
        }
      }
      const stats = yield* lstatAll(
        input.topLevel,
        added.map((entry) => entry.path),
      );
      const settledNs = BigInt(input.startedAt - SETTLED_MS) * 1_000_000n;
      const hashed = added.flatMap((entry, index) => {
        const stat = stats[index];
        return stat !== undefined && stat.regular
          ? [{ ...entry, size: stat.size, stat: stat.stat, settled: stat.changedNs < settledNs }]
          : [];
      });
      const largest = [...kept, ...hashed]
        .sort((left, right) => (left.size < right.size ? 1 : left.size > right.size ? -1 : 0))
        .slice(0, MAX_BLOBS);
      if (largest.reduce((total, blob) => total + blob.size, 0n) < MIN_TOTAL_BYTES) return;

      // Git hashed these under rules nobody recorded. Reading the rules now would pair the blob
      // with whatever they have since become, so only a reading from before staging counts.
      const before = input.before;
      const candidates = largest.flatMap((blob) =>
        "settled" in blob && blob.settled && before?.attributes.get(blob.path) !== undefined
          ? [blob]
          : [],
      );
      const candidatePaths = candidates.map((blob) => blob.path);
      const [config, attributes, changing] = yield* Effect.all(
        [
          readConfig(input.cwd),
          readAttributes(input.topLevel, input.env, candidatePaths),
          changingAttributeDirectories(input.topLevel, candidatePaths, settledNs),
        ],
        { concurrency: "unbounded" },
      );
      // check-attr prints a filter driver named "unspecified" or "unset" like no filter at all.
      if (/\0filter\./.test(config)) return;
      const sameConfig = before !== undefined && config === before.config;
      const admitted = candidates.flatMap((blob, index): UntrackedBlob[] => {
        const value = attributes[index];
        // A clean filter is a program whose output can depend on more than the file.
        return sameConfig &&
          value !== undefined &&
          value === before.attributes.get(blob.path) &&
          /\0(?:unspecified|unset)$/.test(value) &&
          !changing(blob.path)
          ? [
              {
                path: blob.path,
                mode: blob.mode,
                oid: blob.oid,
                size: blob.size,
                stat: blob.stat,
                attributes: value,
              },
            ]
          : [];
      });
      // Reused blobs were checked against the earlier config; a different one now vouches for none.
      const blobs = sameConfig
        ? [...largest.flatMap((blob) => ("settled" in blob ? [] : [blob])), ...admitted]
        : [];
      const remembered = new Set(blobs.map((blob) => blob.path));
      snapshots.set(input.cwd, {
        topLevel: input.topLevel,
        head: input.head,
        config,
        blobs,
        pending: largest.flatMap((blob) => (remembered.has(blob.path) ? [] : [blob.path])),
      });
      if (snapshots.size > MAX_WORKSPACES) snapshots.delete(snapshots.keys().next().value!);
    },
    (effect) => Effect.ignore(effect),
  );

  return { reuse, remember };
};
