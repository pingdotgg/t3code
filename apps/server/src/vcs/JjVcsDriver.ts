import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  type VcsDriverCapabilities,
  type VcsError,
  VcsProcessExitError,
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import { splitNullSeparatedGitStdoutPaths } from "./GitVcsDriverCore.ts";
import * as JjAvailability from "./JjAvailability.ts";
import { makeJjCheckpointOps } from "./JjCheckpoints.ts";
import * as JjProcess from "./JjProcess.ts";
import * as JjRepo from "./JjRepo.ts";
import { makeJjReviewDiff } from "./JjReviewDiff.ts";
import * as VcsDriver from "./VcsDriver.ts";
import { chunkPathsForCheckIgnore, splitLineSeparatedPaths } from "./VcsPathCodecs.ts";
import * as VcsProcess from "./VcsProcess.ts";

export interface JjChangeFileStat {
  /** Repo-relative, as jj templates emit. */
  readonly path: string;
  readonly status: "modified" | "added" | "removed" | "copied" | "renamed";
  readonly linesAdded: number;
  readonly linesRemoved: number;
}

export interface JjChange {
  readonly commitId: string;
  /**
   * Real parents only. The decoder drops any parent jj reports as the root commit, so a first
   * change in a fresh repository yields `[]` instead of the all-zeros root commit id, which
   * `jj restore` accepts (emptying the working copy) and git rejects.
   */
  readonly parentCommitIds: ReadonlyArray<string>;
  readonly description: string;
  readonly empty: boolean;
  readonly conflict: boolean;
  readonly localBookmarks: ReadonlyArray<string>;
  /** Conflict scaffolding rows are filtered out here, once. */
  readonly fileStats: ReadonlyArray<JjChangeFileStat>;
}

export interface JjSegmentRow {
  readonly commitId: string;
  readonly empty: boolean;
  readonly localBookmarks: ReadonlyArray<string>;
}

export interface JjBookmark {
  readonly name: string;
  /** `null` for a local bookmark; the remote name otherwise. The `git` pseudo-remote is dropped. */
  readonly remote: string | null;
  readonly target: string | null;
  readonly tracked: boolean;
  readonly synced: boolean;
  readonly conflict: boolean;
  /** Unix seconds of the target commit's committer timestamp, for date-desc ordering. */
  readonly targetTimestamp: number;
}

export interface JjWorkspace {
  readonly name: string;
  /**
   * Realpath-normalised, or `null` when jj reports no root, which is what `jj workspace list` does
   * for a workspace whose directory was deleted. An empty root is never realpath'd: that resolves
   * to the server process's own cwd, which would hand a thread or a delete the wrong directory.
   */
  readonly root: string | null;
}

type VcsDriverService = VcsDriver.VcsDriver["Service"];

export interface JjVcsDriverShape extends VcsDriverService {
  readonly capabilities: VcsDriverCapabilities & { readonly kind: "jj" };
  readonly repoPaths: (cwd: string) => Effect.Effect<JjRepo.JjRepoPaths, VcsError>;
  /** Always implemented here: `false` for a repository jj detects but cannot operate on. */
  readonly checkpointsUsable: (cwd: string) => Effect.Effect<boolean, never>;
  /** Fails with `VcsUnsupportedOperationError` when jj is missing, old, or non-colocated. */
  readonly ensureUsable: (
    operation: string,
    cwd: string,
  ) => Effect.Effect<JjRepo.JjRepoPaths & { readonly gitDir: string }, VcsError>;
  /** `@`. Snapshots the working copy, that is the point. */
  readonly currentChange: (cwd: string) => Effect.Effect<JjChange, VcsError>;
  /** Any revset, `--limit 1`. `null` when it resolves to nothing, and when it resolves to root. */
  readonly changeAt: (cwd: string, revset: string) => Effect.Effect<JjChange | null, VcsError>;
  /** `heads(::@ & bookmarks())::@`, newest first. Empty when `@` has no bookmarked ancestor. */
  readonly currentSegment: (cwd: string) => Effect.Effect<ReadonlyArray<JjSegmentRow>, VcsError>;
  readonly listBookmarks: (cwd: string) => Effect.Effect<ReadonlyArray<JjBookmark>, VcsError>;
  readonly listWorkspaces: (cwd: string) => Effect.Effect<ReadonlyArray<JjWorkspace>, VcsError>;
  /** Commits in a revset, capped; used for ahead/behind. */
  readonly countRevset: (cwd: string, revset: string) => Effect.Effect<number, VcsError>;
  readonly resolveDefaultBookmark: (cwd: string) => Effect.Effect<string | null, VcsError>;
  readonly listRemoteNames: (cwd: string) => Effect.Effect<ReadonlyArray<string>, VcsError>;
  readonly resolvePrimaryRemoteName: (cwd: string) => Effect.Effect<string | null, VcsError>;
  /** Drops this repo's cached default bookmark and remote names. */
  readonly invalidateRepoCaches: (cwd: string) => Effect.Effect<void, never>;
}

export class JjVcsDriver extends Context.Service<JjVcsDriver, JjVcsDriverShape>()(
  "t3/vcs/JjVcsDriver",
) {}

const REPO_PATHS_CACHE_CAPACITY = 2_048;
const REPO_PATHS_CACHE_TTL = Duration.minutes(10);
const REPO_METADATA_CACHE_CAPACITY = 512;
const REPO_METADATA_CACHE_TTL = Duration.minutes(5);
const WORKSPACE_FILES_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_BASE_BOOKMARK_CANDIDATES = ["main", "master"] as const;
/** 64 KiB of one-byte rows caps the count near 32k commits, far past anything the UI renders. */
const COUNT_REVSET_MAX_OUTPUT_BYTES = 64 * 1024;
const CONFLICT_SCAFFOLDING_PREFIX = ".jjconflict-";
const CONFLICT_SCAFFOLDING_README = "JJ-CONFLICT-README";
/** jj's colocated pseudo-remote: it mirrors `refs/heads`, so it is never a real remote row. */
const GIT_PSEUDO_REMOTE = "git";

const CHANGE_TEMPLATE =
  '"{" ++ "\\"commit_id\\":" ++ json(commit_id) ++' +
  ' ",\\"root\\":" ++ json(self.root()) ++' +
  ' ",\\"parents\\":" ++ json(parents.map(|p| p.commit_id())) ++' +
  ' ",\\"parent_roots\\":" ++ json(parents.map(|p| p.root())) ++' +
  ' ",\\"description\\":" ++ json(description) ++' +
  ' ",\\"empty\\":" ++ json(empty) ++' +
  ' ",\\"conflict\\":" ++ json(conflict) ++' +
  ' ",\\"local_bookmarks\\":" ++ json(local_bookmarks.map(|b| b.name())) ++' +
  ' ",\\"files\\":[" ++ self.diff().stat().files().map(|f|' +
  ' "{\\"path\\":" ++ json(f.path()) ++' +
  ' ",\\"status\\":" ++ json(f.status()) ++' +
  ' ",\\"added\\":" ++ json(f.lines_added()) ++' +
  ' ",\\"removed\\":" ++ json(f.lines_removed()) ++ "}").join(",") ++ "]" ++ "}\\n"';

const SEGMENT_TEMPLATE =
  '"{\\"commit_id\\":" ++ json(commit_id) ++' +
  ' ",\\"empty\\":" ++ json(empty) ++' +
  ' ",\\"local_bookmarks\\":" ++ json(local_bookmarks.map(|b| b.name())) ++ "}\\n"';

const BOOKMARK_TEMPLATE =
  '"{" ++ "\\"name\\":" ++ json(name) ++' +
  ' ",\\"remote\\":" ++ json(remote) ++' +
  ' ",\\"tracked\\":" ++ json(tracked) ++' +
  ' ",\\"synced\\":" ++ json(synced) ++' +
  ' ",\\"conflict\\":" ++ json(conflict) ++' +
  ' ",\\"present\\":" ++ json(present) ++' +
  ' ",\\"target\\":" ++ if(conflict || !present, "null", json(normal_target.commit_id())) ++' +
  ' ",\\"timestamp\\":" ++' +
  ' if(conflict || !present, "\\"0\\"", json(normal_target.committer().timestamp().utc().format("%s"))) ++' +
  ' "}\\n"';

const WORKSPACE_TEMPLATE =
  '"{\\"name\\":" ++ json(name) ++ ",\\"root\\":" ++ json(stringify(root)) ++ "}\\n"';

const FILE_LIST_TEMPLATE = 'json(path) ++ "\\n"';

const JjChangeRow = Schema.Struct({
  commit_id: Schema.String,
  root: Schema.Boolean,
  parents: Schema.Array(Schema.String),
  parent_roots: Schema.Array(Schema.Boolean),
  description: Schema.String,
  empty: Schema.Boolean,
  conflict: Schema.Boolean,
  local_bookmarks: Schema.Array(Schema.String),
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      status: Schema.Literals(["modified", "added", "removed", "copied", "renamed"]),
      added: Schema.Number,
      removed: Schema.Number,
    }),
  ),
});

const JjSegmentRowSchema = Schema.Struct({
  commit_id: Schema.String,
  empty: Schema.Boolean,
  local_bookmarks: Schema.Array(Schema.String),
});

const JjBookmarkRow = Schema.Struct({
  name: Schema.String,
  remote: Schema.NullOr(Schema.String),
  tracked: Schema.Boolean,
  synced: Schema.Boolean,
  conflict: Schema.Boolean,
  present: Schema.Boolean,
  target: Schema.NullOr(Schema.String),
  /** jj's `format("%s")` renders through a template, so this arrives as a JSON string. */
  timestamp: Schema.String,
});

const JjWorkspaceRow = Schema.Struct({
  name: Schema.String,
  root: Schema.String,
});

const decodeChangeRow = Schema.decodeUnknownEffect(Schema.fromJsonString(JjChangeRow));
const decodeSegmentRow = Schema.decodeUnknownEffect(Schema.fromJsonString(JjSegmentRowSchema));
const decodeBookmarkRow = Schema.decodeUnknownEffect(Schema.fromJsonString(JjBookmarkRow));
const decodeWorkspaceRow = Schema.decodeUnknownEffect(Schema.fromJsonString(JjWorkspaceRow));
const decodePathRow = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.String));

const decodeFailure = (operation: string, command: string, cwd: string) =>
  Effect.mapError(
    (cause: unknown) =>
      new VcsProcessExitError({
        operation,
        command,
        cwd,
        exitCode: 0,
        detail: `Could not decode ${command} output: ${String(cause)}`,
      }),
  );

/** Freshness stamp for data the driver just read out of the local working copy. */
const nowFreshness = Effect.fn("JjVcsDriver.nowFreshness")(function* () {
  const now = yield* DateTime.now;
  return {
    source: "live-local" as const,
    observedAt: now,
    expiresAt: Option.none(),
  };
});

function isConflictScaffolding(filePath: string): boolean {
  return (
    filePath.startsWith(CONFLICT_SCAFFOLDING_PREFIX) || filePath === CONFLICT_SCAFFOLDING_README
  );
}

function toJjChange(row: typeof JjChangeRow.Type): JjChange {
  return {
    commitId: row.commit_id,
    parentCommitIds: row.parents.filter((_, index) => row.parent_roots[index] !== true),
    description: row.description,
    empty: row.empty,
    conflict: row.conflict,
    localBookmarks: row.local_bookmarks,
    fileStats: row.files
      .filter((file) => !isConflictScaffolding(file.path))
      .map((file) => ({
        path: file.path,
        status: file.status,
        linesAdded: file.added,
        linesRemoved: file.removed,
      })),
  };
}

function parseRemoteListLine(line: string): { name: string; url: string } | null {
  const separatorIndex = line.search(/\s/);
  if (separatorIndex <= 0) {
    return null;
  }
  const name = line.slice(0, separatorIndex);
  const url = line.slice(separatorIndex + 1).trim();
  return url.length > 0 ? { name, url } : null;
}

const makeRepoCache = <A>(
  capacity: number,
  timeToLive: Duration.Duration,
  lookup: (repoRoot: string) => Effect.Effect<A, VcsError>,
) =>
  Cache.makeWith<string, A, VcsError>(lookup, {
    capacity,
    timeToLive: Exit.match({ onSuccess: () => timeToLive, onFailure: () => Duration.zero }),
  });

export const makeVcsDriverShape = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const availability = yield* JjAvailability.makeJjAvailability;

  const capabilities = {
    kind: "jj",
    supportsWorktrees: false,
    supportsBookmarks: true,
    supportsAtomicSnapshot: true,
    supportsPushDefaultRemote: false,
    ignoreClassifier: "git-compatible-fallback",
  } as const satisfies VcsDriverCapabilities & { readonly kind: "jj" };

  const repoPathsCache = yield* makeRepoCache(
    REPO_PATHS_CACHE_CAPACITY,
    REPO_PATHS_CACHE_TTL,
    (workspaceRoot) => JjRepo.resolveJjRepoPaths(fileSystem, path, workspaceRoot),
  );

  const markerRoot = (cwd: string) => JjRepo.findVcsMarkerRoot(fileSystem, path, cwd);

  const repoPaths: JjVcsDriverShape["repoPaths"] = Effect.fn("JjVcsDriver.repoPaths")(function* (
    cwd: string,
  ) {
    const marker = yield* markerRoot(cwd);
    if (marker === null || marker.marker !== "jj") {
      return yield* Effect.fail(
        new VcsRepositoryDetectionError({
          operation: "JjVcsDriver.repoPaths",
          cwd,
          detail: "No Jujutsu workspace was found at this path.",
        }),
      );
    }
    return yield* Cache.get(repoPathsCache, marker.root);
  });

  const ensureUsable: JjVcsDriverShape["ensureUsable"] = Effect.fn("JjVcsDriver.ensureUsable")(
    function* (operation: string, cwd: string) {
      const paths = yield* repoPaths(cwd);
      const reason = JjAvailability.jjUnsupportedReason({
        availability: yield* availability(paths.workspaceRoot),
        colocated: paths.gitDir !== null,
      });
      if (reason !== null || paths.gitDir === null) {
        return yield* Effect.fail(
          new VcsUnsupportedOperationError({
            operation,
            kind: "jj",
            detail: reason ?? "This Jujutsu workspace has no colocated Git store.",
          }),
        );
      }
      return { ...paths, gitDir: paths.gitDir };
    },
  );

  const jjLog = (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    options?: JjProcess.JjCommandOptions,
  ) => JjProcess.jjCommand(vcsProcess, operation, cwd, args, options);

  const changeFromRevset = Effect.fn("JjVcsDriver.changeFromRevset")(function* (
    operation: string,
    cwd: string,
    revset: string,
    ignoreWorkingCopy: boolean,
  ): Effect.fn.Return<JjChange | null, VcsError> {
    const result = yield* jjLog(
      operation,
      cwd,
      ["log", "-r", revset, "--no-graph", "--limit", "1", "-T", CHANGE_TEMPLATE],
      { timeoutMs: 20_000, maxOutputBytes: 4 * 1024 * 1024, ignoreWorkingCopy },
    );

    const line = splitLineSeparatedPaths(result.stdout, result.stdoutTruncated)[0];
    if (line === undefined) {
      return null;
    }

    const row = yield* decodeChangeRow(line).pipe(decodeFailure(operation, "jj log", cwd));
    return row.root ? null : toJjChange(row);
  });

  const currentChange: JjVcsDriverShape["currentChange"] = Effect.fn("JjVcsDriver.currentChange")(
    function* (cwd: string) {
      const operation = "JjVcsDriver.currentChange";
      yield* ensureUsable(operation, cwd);
      const change = yield* changeFromRevset(operation, cwd, "@", false);
      if (change === null) {
        return yield* Effect.fail(
          new VcsProcessExitError({
            operation,
            command: "jj log",
            cwd,
            exitCode: 0,
            detail: "jj reported no working-copy change for this workspace.",
          }),
        );
      }
      return change;
    },
  );

  const changeAt: JjVcsDriverShape["changeAt"] = Effect.fn("JjVcsDriver.changeAt")(function* (
    cwd: string,
    revset: string,
  ) {
    const operation = "JjVcsDriver.changeAt";
    yield* ensureUsable(operation, cwd);
    return yield* changeFromRevset(operation, cwd, revset, true);
  });

  const currentSegment: JjVcsDriverShape["currentSegment"] = Effect.fn(
    "JjVcsDriver.currentSegment",
  )(function* (cwd: string) {
    const operation = "JjVcsDriver.currentSegment";
    yield* ensureUsable(operation, cwd);
    const result = yield* jjLog(
      operation,
      cwd,
      ["log", "-r", "heads(::@ & bookmarks())::@", "--no-graph", "-T", SEGMENT_TEMPLATE],
      {
        allowNonZeroExit: true,
        ignoreWorkingCopy: true,
        timeoutMs: 20_000,
        maxOutputBytes: 1024 * 1024,
        outputMode: "truncate",
      },
    );

    if (result.exitCode !== 0) {
      return [];
    }

    const rows = yield* Effect.forEach(
      splitLineSeparatedPaths(result.stdout, result.stdoutTruncated),
      (line) => decodeSegmentRow(line).pipe(decodeFailure(operation, "jj log", cwd)),
    );

    return rows.map((row) => ({
      commitId: row.commit_id,
      empty: row.empty,
      localBookmarks: row.local_bookmarks,
    }));
  });

  const listBookmarks: JjVcsDriverShape["listBookmarks"] = Effect.fn("JjVcsDriver.listBookmarks")(
    function* (cwd: string) {
      const operation = "JjVcsDriver.listBookmarks";
      yield* ensureUsable(operation, cwd);
      const result = yield* jjLog(
        operation,
        cwd,
        ["bookmark", "list", "--all-remotes", "-T", BOOKMARK_TEMPLATE],
        {
          ignoreWorkingCopy: true,
          timeoutMs: 10_000,
          maxOutputBytes: 1024 * 1024,
          outputMode: "truncate",
        },
      );

      const rows = yield* Effect.forEach(
        splitLineSeparatedPaths(result.stdout, result.stdoutTruncated),
        (line) => decodeBookmarkRow(line).pipe(decodeFailure(operation, "jj bookmark list", cwd)),
      );

      return rows
        .filter((row) => row.present && row.remote !== GIT_PSEUDO_REMOTE)
        .map((row) => {
          const timestamp = Number.parseInt(row.timestamp, 10);
          return {
            name: row.name,
            remote: row.remote,
            target: row.target,
            tracked: row.tracked,
            synced: row.synced,
            conflict: row.conflict,
            targetTimestamp: Number.isNaN(timestamp) ? 0 : timestamp,
          } satisfies JjBookmark;
        });
    },
  );

  const listWorkspaces: JjVcsDriverShape["listWorkspaces"] = Effect.fn(
    "JjVcsDriver.listWorkspaces",
  )(function* (cwd: string) {
    const operation = "JjVcsDriver.listWorkspaces";
    yield* ensureUsable(operation, cwd);
    const result = yield* jjLog(operation, cwd, ["workspace", "list", "-T", WORKSPACE_TEMPLATE], {
      ignoreWorkingCopy: true,
      timeoutMs: 10_000,
      maxOutputBytes: 1024 * 1024,
      outputMode: "truncate",
    });

    const rows = yield* Effect.forEach(
      splitLineSeparatedPaths(result.stdout, result.stdoutTruncated),
      (line) => decodeWorkspaceRow(line).pipe(decodeFailure(operation, "jj workspace list", cwd)),
    );

    return yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        const root =
          row.root.length === 0
            ? null
            : yield* fileSystem.realPath(row.root).pipe(Effect.orElseSucceed(() => row.root));
        return { name: row.name, root } satisfies JjWorkspace;
      }),
    );
  });

  const countRevset: JjVcsDriverShape["countRevset"] = Effect.fn("JjVcsDriver.countRevset")(
    function* (cwd: string, revset: string) {
      const operation = "JjVcsDriver.countRevset";
      yield* ensureUsable(operation, cwd);
      const result = yield* jjLog(
        operation,
        cwd,
        ["log", "-r", revset, "--no-graph", "-T", '"1\\n"'],
        {
          allowNonZeroExit: true,
          ignoreWorkingCopy: true,
          timeoutMs: 20_000,
          maxOutputBytes: COUNT_REVSET_MAX_OUTPUT_BYTES,
          outputMode: "truncate",
        },
      );

      return result.exitCode === 0
        ? splitLineSeparatedPaths(result.stdout, result.stdoutTruncated).length
        : 0;
    },
  );

  const listRemotes: VcsDriver.VcsDriver["Service"]["listRemotes"] = Effect.fn(
    "JjVcsDriver.listRemotes",
  )(function* (cwd: string) {
    const operation = "JjVcsDriver.listRemotes";
    yield* ensureUsable(operation, cwd);
    const result = yield* jjLog(operation, cwd, ["git", "remote", "list"], {
      allowNonZeroExit: true,
      ignoreWorkingCopy: true,
      timeoutMs: 5_000,
      maxOutputBytes: 64 * 1024,
    });

    const remotes =
      result.exitCode === 0
        ? splitLineSeparatedPaths(result.stdout, result.stdoutTruncated).flatMap((line) => {
            const remote = parseRemoteListLine(line);
            return remote === null
              ? []
              : [
                  {
                    name: remote.name,
                    url: remote.url,
                    pushUrl: Option.none<string>(),
                    isPrimary: remote.name === "origin",
                  },
                ];
          })
        : [];

    return { remotes, freshness: yield* nowFreshness() };
  });

  const remoteNamesCache = yield* makeRepoCache(
    REPO_METADATA_CACHE_CAPACITY,
    REPO_METADATA_CACHE_TTL,
    (mainWorkspaceRoot) =>
      listRemotes(mainWorkspaceRoot).pipe(
        Effect.map((result) => result.remotes.map((remote) => remote.name)),
      ),
  );

  const listRemoteNames: JjVcsDriverShape["listRemoteNames"] = Effect.fn(
    "JjVcsDriver.listRemoteNames",
  )(function* (cwd: string) {
    const paths = yield* ensureUsable("JjVcsDriver.listRemoteNames", cwd);
    return yield* Cache.get(remoteNamesCache, paths.mainWorkspaceRoot);
  });

  const resolvePrimaryRemoteName: JjVcsDriverShape["resolvePrimaryRemoteName"] = Effect.fn(
    "JjVcsDriver.resolvePrimaryRemoteName",
  )(function* (cwd: string) {
    const names = yield* listRemoteNames(cwd);
    return names.includes("origin") ? "origin" : (names[0] ?? null);
  });

  const resolveDefaultBookmarkUncached = Effect.fn("JjVcsDriver.resolveDefaultBookmarkUncached")(
    function* (cwd: string): Effect.fn.Return<string | null, VcsError> {
      const bookmarks = yield* listBookmarks(cwd);
      const trunkChange = yield* changeAt(cwd, "trunk()");

      if (trunkChange !== null) {
        const primaryRemote = yield* resolvePrimaryRemoteName(cwd);
        const remoteMatch = bookmarks.find(
          (bookmark) =>
            bookmark.target === trunkChange.commitId &&
            bookmark.remote === primaryRemote &&
            !bookmark.conflict,
        );
        if (remoteMatch) {
          return remoteMatch.name;
        }

        const localMatches = bookmarks
          .filter(
            (bookmark) => bookmark.target === trunkChange.commitId && bookmark.remote === null,
          )
          .map((bookmark) => bookmark.name)
          .sort();
        if (localMatches[0] !== undefined) {
          return localMatches[0];
        }
      }

      const localNames = new Set(
        bookmarks.filter((bookmark) => bookmark.remote === null).map((bookmark) => bookmark.name),
      );
      return (
        DEFAULT_BASE_BOOKMARK_CANDIDATES.find((candidate) => localNames.has(candidate)) ?? null
      );
    },
  );

  const defaultBookmarkCache = yield* makeRepoCache(
    REPO_METADATA_CACHE_CAPACITY,
    REPO_METADATA_CACHE_TTL,
    resolveDefaultBookmarkUncached,
  );

  const resolveDefaultBookmark: JjVcsDriverShape["resolveDefaultBookmark"] = Effect.fn(
    "JjVcsDriver.resolveDefaultBookmark",
  )(function* (cwd: string) {
    const paths = yield* ensureUsable("JjVcsDriver.resolveDefaultBookmark", cwd);
    return yield* Cache.get(defaultBookmarkCache, paths.mainWorkspaceRoot);
  });

  const invalidateRepoCaches: JjVcsDriverShape["invalidateRepoCaches"] = Effect.fn(
    "JjVcsDriver.invalidateRepoCaches",
  )(function* (cwd: string) {
    const marker = yield* markerRoot(cwd);
    if (marker === null || marker.marker !== "jj") {
      return;
    }
    const paths = yield* Cache.get(repoPathsCache, marker.root).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (paths === null) {
      return;
    }
    yield* Cache.invalidate(remoteNamesCache, paths.mainWorkspaceRoot);
    yield* Cache.invalidate(defaultBookmarkCache, paths.mainWorkspaceRoot);
  });

  const isInsideWorkTree: VcsDriver.VcsDriver["Service"]["isInsideWorkTree"] = (cwd) =>
    markerRoot(cwd).pipe(Effect.map((marker) => marker?.marker === "jj"));

  const detectRepository: VcsDriver.VcsDriver["Service"]["detectRepository"] = Effect.fn(
    "JjVcsDriver.detectRepository",
  )(function* (cwd: string) {
    const marker = yield* markerRoot(cwd);
    if (marker === null || marker.marker !== "jj") {
      return null;
    }
    return {
      kind: "jj" as const,
      rootPath: marker.root,
      metadataPath: path.join(marker.root, ".jj"),
      freshness: yield* nowFreshness(),
    };
  });

  const execute: VcsDriver.VcsDriver["Service"]["execute"] = (input) =>
    jjLog(input.operation, input.cwd, input.args, input);

  const initRepository: VcsDriver.VcsDriver["Service"]["initRepository"] = (input) =>
    jjLog("JjVcsDriver.initRepository", input.cwd, ["git", "init", "--colocate"], {
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
    }).pipe(Effect.asVoid);

  const listWorkspaceFiles: VcsDriver.VcsDriver["Service"]["listWorkspaceFiles"] = Effect.fn(
    "JjVcsDriver.listWorkspaceFiles",
  )(function* (cwd: string) {
    const operation = "JjVcsDriver.listWorkspaceFiles";
    const paths = yield* ensureUsable(operation, cwd);
    const result = yield* jjLog(operation, cwd, ["file", "list", ".", "-T", FILE_LIST_TEMPLATE], {
      timeoutMs: 20_000,
      maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
      outputMode: "truncate",
    });

    // jj templates emit repo-relative paths; `git ls-files`, and every caller, expects them
    // relative to the cwd that was listed.
    const resolvedCwd = yield* fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));
    const relativeCwd = path.relative(paths.workspaceRoot, resolvedCwd).split(path.sep).join("/");
    const prefix = relativeCwd.length === 0 ? "" : `${relativeCwd}/`;

    const repoRelativePaths = yield* Effect.forEach(
      splitLineSeparatedPaths(result.stdout, result.stdoutTruncated),
      (line) => decodePathRow(line).pipe(decodeFailure(operation, "jj file list", cwd)),
    );

    return {
      paths: repoRelativePaths.map((repoRelativePath) =>
        repoRelativePath.startsWith(prefix)
          ? repoRelativePath.slice(prefix.length)
          : repoRelativePath,
      ),
      truncated: result.stdoutTruncated,
      freshness: yield* nowFreshness(),
    };
  });

  const filterIgnoredPaths: VcsDriver.VcsDriver["Service"]["filterIgnoredPaths"] = Effect.fn(
    "JjVcsDriver.filterIgnoredPaths",
  )(function* (cwd: string, relativePaths: ReadonlyArray<string>) {
    if (relativePaths.length === 0) {
      return relativePaths;
    }

    const operation = "JjVcsDriver.filterIgnoredPaths";
    // Deliberately not `ensureUsable`: nothing here spawns jj, and leaving the paths unfiltered in
    // a repository T3 cannot operate on is safer than failing the caller's whole listing.
    const paths = yield* repoPaths(cwd);
    if (paths.gitDir === null) {
      return relativePaths;
    }

    const ignoredPaths = new Set<string>();
    for (const chunk of chunkPathsForCheckIgnore(relativePaths)) {
      const result = yield* JjProcess.colocatedGitCommand(
        vcsProcess,
        operation,
        { gitDir: paths.gitDir, workTree: cwd, cwd },
        ["check-ignore", "--no-index", "-z", "--stdin"],
        {
          stdin: `${chunk.join("\0")}\0`,
          allowNonZeroExit: true,
          timeoutMs: 20_000,
          maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
          appendTruncationMarker: true,
        },
      );

      if (result.exitCode !== 0 && result.exitCode !== 1) {
        return yield* Effect.fail(
          new VcsProcessExitError({
            operation,
            command: "git check-ignore",
            cwd,
            exitCode: result.exitCode,
            detail: result.stderr.trim() || "git check-ignore failed",
          }),
        );
      }

      for (const ignoredPath of splitNullSeparatedGitStdoutPaths(result)) {
        ignoredPaths.add(ignoredPath);
      }
    }

    return ignoredPaths.size === 0
      ? relativePaths
      : relativePaths.filter((relativePath) => !ignoredPaths.has(relativePath));
  });

  const checkpointsUsable: JjVcsDriverShape["checkpointsUsable"] = (cwd) =>
    ensureUsable("JjVcsDriver.checkpointsUsable", cwd).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  const ensureGitDir = (operation: string, cwd: string) =>
    ensureUsable(operation, cwd).pipe(Effect.map((paths) => paths.gitDir));

  const reviewDiff = makeJjReviewDiff({
    process: vcsProcess,
    ensureGitDir,
    currentChange,
    changeAt,
    listRemoteNames,
    resolveDefaultBookmark,
  });

  return {
    capabilities,
    execute,
    checkpoints: makeJjCheckpointOps({ process: vcsProcess, ensureGitDir, currentChange }),
    checkpointsUsable,
    detectRepository,
    isInsideWorkTree,
    listWorkspaceFiles,
    listRemotes,
    filterIgnoredPaths,
    initRepository,
    getDiffPreview: reviewDiff.getDiffPreview,
    getDiffFileContents: reviewDiff.getDiffFileContents,
    repoPaths,
    ensureUsable,
    currentChange,
    changeAt,
    currentSegment,
    listBookmarks,
    listWorkspaces,
    countRevset,
    resolveDefaultBookmark,
    listRemoteNames,
    resolvePrimaryRemoteName,
    invalidateRepoCaches,
  } satisfies JjVcsDriverShape;
});

export const makeJjVcsDriver = Effect.map(makeVcsDriverShape, (shape) => JjVcsDriver.of(shape));

export const makeVcsDriver = Effect.map(makeVcsDriverShape, (shape) =>
  VcsDriver.VcsDriver.of(shape),
);

export const layer = Layer.effect(JjVcsDriver, makeJjVcsDriver);
export const vcsLayer = Layer.effect(VcsDriver.VcsDriver, makeVcsDriver);
