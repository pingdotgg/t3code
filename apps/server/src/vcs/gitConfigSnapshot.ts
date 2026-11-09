// @effect-diagnostics-next-line nodeBuiltinImport:off - Effect's File.Info has no ctime or nanosecond mtime, which the fingerprint needs.
import * as NodeFS from "node:fs";

import type { GitCommandError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as GitVcsDriver from "./GitVcsDriver.ts";

export interface GitConfigEntry {
  readonly origin: string;
  readonly key: string;
  readonly value: string | null;
}

// `git config --list --show-origin -z` prints origin NUL key [LF value] NUL; no LF means no value.
export const parseGitConfigList = (stdout: string): ReadonlyArray<GitConfigEntry> | null => {
  if (stdout.length === 0) return [];
  if (!stdout.endsWith("\0")) return null;
  const records = stdout.slice(0, -1).split("\0");
  if (records.length % 2 !== 0) return null;
  const entries: GitConfigEntry[] = [];
  for (let index = 0; index < records.length; index += 2) {
    const record = records[index + 1]!;
    const newline = record.indexOf("\n");
    entries.push({
      origin: records[index]!,
      key: newline === -1 ? record : record.slice(0, newline),
      value: newline === -1 ? null : record.slice(newline + 1),
    });
  }
  return entries;
};

const lowerAscii = (value: string) => value.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());

// Git matches keys with the section and variable name lowercased and the subsection as written.
const canonicalGitConfigKey = (key: string) => {
  const first = key.indexOf(".");
  if (first === -1) return key;
  const last = key.lastIndexOf(".");
  return `${lowerAscii(key.slice(0, first))}${key.slice(first, last + 1)}${lowerAscii(key.slice(last + 1))}`;
};

// What `git config --get <key>` prints: the last value, an empty line for a key without one.
export const gitConfigGetOutput = (
  values: ReadonlyMap<string, string | null>,
  key: string,
): string => {
  const canonicalKey = canonicalGitConfigKey(key);
  if (!values.has(canonicalKey)) return "";
  return `${values.get(canonicalKey) ?? ""}\n`;
};

const INCLUDE_CONDITION_PREFIXES = ["gitdir:", "gitdir/i:", "hasconfig:remote.*.url:"] as const;

const includeTarget = (
  value: string | null,
  originPath: string | null,
  options: GitConfigDependencyOptions,
): string | null => {
  if (value === null || value.length === 0) return null;
  if (value.startsWith("~")) {
    if (value !== "~" && !value.startsWith("~/")) return null;
    return options.home ? `${options.home}${value.slice(1)}` : null;
  }
  if (value.startsWith("%(prefix)/")) return null;
  if (options.isAbsolute(value)) return value;
  if (originPath === null || !options.isAbsolute(originPath)) return null;
  // Git appends a relative include to the including file's directory without normalising it.
  const separator = Math.max(
    originPath.lastIndexOf("/"),
    options.windows ? originPath.lastIndexOf("\\") : -1,
  );
  return `${originPath.slice(0, separator + 1)}${value}`;
};

export interface GitConfigDependencyOptions {
  readonly home: string | undefined;
  readonly windows: boolean;
  readonly isAbsolute: (path: string) => boolean;
}

/**
 * Files the listed values came from, and the includes they name (read or not), so a change to
 * any of them is seen. Relative origins are the repository's own config files, which the caller
 * tracks. `supported` is false when a value may depend on something these files do not cover.
 */
export const gitConfigListDependencies = (
  entries: ReadonlyArray<GitConfigEntry>,
  options: GitConfigDependencyOptions,
): { readonly paths: ReadonlyArray<string>; readonly supported: boolean } => {
  const paths = new Set<string>();
  let supported = true;
  for (const entry of entries) {
    let originPath: string | null = null;
    if (entry.origin.startsWith("file:")) {
      originPath = entry.origin.slice("file:".length);
      if (options.isAbsolute(originPath)) paths.add(originPath);
    } else if (entry.origin !== "command line:") {
      supported = false;
    }
    const conditional = entry.key.startsWith("includeif.") && entry.key.endsWith(".path");
    if (entry.key !== "include.path" && !conditional) continue;
    if (conditional) {
      const condition = entry.key.slice("includeif.".length, -".path".length);
      if (!INCLUDE_CONDITION_PREFIXES.some((prefix) => condition.startsWith(prefix))) {
        supported = false;
      }
    }
    const target = includeTarget(entry.value, originPath, options);
    if (target === null) supported = false;
    else paths.add(target);
  }
  return { paths: [...paths], supported };
};

const CONFIG_ENVIRONMENT_NAMES = [
  "HOME",
  "XDG_CONFIG_HOME",
  "PATH",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_WORK_TREE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
] as const;
const MAX_CONFIG_ENVIRONMENT_ENTRIES = 1_000;

// The environment that chooses which config Git reads; null when `GIT_CONFIG` names the only file
// or there are more `GIT_CONFIG_KEY_<n>` overrides than the signature takes.
export const gitConfigEnvironmentSignature = (env: NodeJS.ProcessEnv): string | null => {
  if (env.GIT_CONFIG !== undefined) return null;
  const parts: Array<string | null> = CONFIG_ENVIRONMENT_NAMES.map((name) => env[name] ?? null);
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? "", 10);
  if (count > MAX_CONFIG_ENVIRONMENT_ENTRIES) return null;
  for (let index = 0; index < count; index++) {
    parts.push(env[`GIT_CONFIG_KEY_${index}`] ?? null, env[`GIT_CONFIG_VALUE_${index}`] ?? null);
  }
  return JSON.stringify(parts);
};

export interface GitConfigDependency {
  readonly path: string;
  /**
   * content: any change. identity: a directory's identity, mode and owners (a file's content), for
   * the `.git` Git rewrites often. presence: whether it exists, with its mode and owners. absent: the
   * snapshot holds only while it is missing, for the markers that would make Git find another
   * repository on the way up.
   */
  readonly kind: "content" | "identity" | "presence" | "absent";
}

const dependencyKey = (dependency: GitConfigDependency) => `${dependency.kind}:${dependency.path}`;

// Git replaces config files by rename, which changes the inode. An in-place edit of the same size can
// go unseen when it lands within the filesystem's timestamp granularity (Linux stamps from a coarse
// clock, ~4 ms) or behind NFS attribute caching. Every kind counts the type, permission bits and
// owners, which discovery and safe.directory read; an ACL-only change is not seen.
const describeStats = (kind: GitConfigDependency["kind"], stats: NodeFS.BigIntStats) => {
  const access = `${stats.mode}:${stats.uid}:${stats.gid}`;
  if (kind === "presence" || kind === "absent") return access;
  const identity = `${stats.dev}:${stats.ino}:${access}`;
  return kind === "identity" && stats.isDirectory()
    ? identity
    : `${identity}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
};

const statOf = (path: string, follow: boolean) =>
  new Promise<NodeFS.BigIntStats | string>((resolve) => {
    const done = (error: NodeJS.ErrnoException | null, stats: NodeFS.BigIntStats) =>
      resolve(error ? `!${error.code ?? "error"}` : stats);
    try {
      if (follow) NodeFS.stat(path, { bigint: true }, done);
      else NodeFS.lstat(path, { bigint: true }, done);
    } catch {
      resolve("!invalid");
    }
  });

// Git reads owners with lstat, so an identity that is a link counts as itself and as its target.
const statFingerprint = async ({ path, kind }: GitConfigDependency) => {
  const describe = (stats: NodeFS.BigIntStats | string) =>
    typeof stats === "string" ? stats : describeStats(kind, stats);
  if (kind !== "identity") return describe(await statOf(path, true));
  const link = await statOf(path, false);
  if (typeof link === "string" || !link.isSymbolicLink()) return describe(link);
  return `${describe(link)}>${describe(await statOf(path, true))}`;
};

const fingerprintDependencies = (dependencies: ReadonlyArray<GitConfigDependency>) =>
  Effect.promise(() => Promise.all(dependencies.map(statFingerprint)));

const fileIdentity = (path: string) =>
  new Promise<string | null>((resolve) => {
    try {
      NodeFS.stat(path, { bigint: true }, (error, stats) =>
        resolve(error ? null : `${stats.dev}:${stats.ino}`),
      );
    } catch {
      resolve(null);
    }
  });

const isSameFile = (left: string, right: string) =>
  Effect.promise(() => Promise.all([fileIdentity(left), fileIdentity(right)])).pipe(
    Effect.map(
      ([leftIdentity, rightIdentity]) => leftIdentity !== null && leftIdentity === rightIdentity,
    ),
  );

export interface GitConfigSnapshot {
  readonly values: ReadonlyMap<string, string | null>;
  // Results of commands that read only config, valid while the snapshot is.
  readonly results: Map<string, GitVcsDriver.ExecuteGitResult>;
}

interface CachedGitConfigSnapshot {
  readonly dependencies: ReadonlyArray<GitConfigDependency>;
  readonly fingerprint: string;
  // null: a value may depend on something the dependencies miss, so every read runs Git.
  readonly snapshot: GitConfigSnapshot | null;
}

type RunGit = (
  operation: string,
  cwd: string,
  args: ReadonlyArray<string>,
) => Effect.Effect<GitVcsDriver.ExecuteGitResult, GitCommandError>;

// Snapshots are per directory and config environment, so a read never sees another environment's
// config. JSON escapes NUL and a path cannot hold one, so the key splits at its first NUL.
const snapshotKey = (cwd: string, environment: string) => `${environment}\0${cwd}`;

const CONFIG_SNAPSHOT_CACHE_CAPACITY = 2_048;
const CONFIG_SNAPSHOT_RETRY_TTL = Duration.seconds(1);
const CONFIG_SNAPSHOT_LOAD_ATTEMPTS = 3;
const CONFIG_FILE_LOCATIONS_CAPACITY = 16;
const REPOSITORY_PATH_COUNT = 10;
const REUSED_RESULTS_CAPACITY = 64;
const REPOSITORY_PATH_ARGS = [
  "rev-parse",
  "--path-format=absolute",
  "--show-toplevel",
  "--absolute-git-dir",
  "--git-path",
  "config",
  "--git-path",
  "config.worktree",
  "--git-path",
  "commondir",
  "--git-path",
  "remotes",
  "--git-path",
  "branches",
  "--git-path",
  "HEAD",
  "--git-path",
  "objects",
  "--git-path",
  "refs",
  "--show-prefix",
] as const;

/**
 * Snapshots of `git config --list` per directory and config environment, reused while the files
 * that chose and supplied those values keep the same stat. Every dependency is stat'ed before the
 * read that depends on it, so a write during a load leaves the snapshot stale rather than wrong.
 */
export const makeGitConfigSnapshots = Effect.fn("makeGitConfigSnapshots")(function* (
  runGit: RunGit,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const windows = (yield* HostProcess.Platform) === "win32";
  // Git before 2.42 has no `git var GIT_CONFIG_*`, so it cannot name its global and system files.
  let supported = true;
  const configFileLocations = new Map<string, ReadonlyArray<string>>();
  const readOnce = new Set<string>();
  const reloadDependencies = new Map<string, ReadonlyArray<GitConfigDependency>>();

  const listDirectory = (directory: string) =>
    fileSystem.readDirectory(directory).pipe(
      Effect.map((names) => names.map((name) => path.join(directory, name))),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    );

  const configFiles = (result: GitVcsDriver.ExecuteGitResult) => {
    if (result.exitCode === 0) return result.stdout.split("\n").filter((line) => line.length > 0);
    if (result.exitCode === 1) return [];
    if (result.exitCode === 129) supported = false;
    return null;
  };

  // The global and system files depend only on the environment and the Git build.
  const readConfigFileLocations = Effect.fn("GitVcsDriver.configSnapshot.configFiles")(function* (
    cwd: string,
    environment: string,
  ) {
    const known = configFileLocations.get(environment);
    if (known !== undefined) return known;
    const [globalResult, systemResult] = yield* Effect.all(
      [
        runGit("GitVcsDriver.configSnapshot.globalFiles", cwd, ["var", "GIT_CONFIG_GLOBAL"]),
        runGit("GitVcsDriver.configSnapshot.systemFiles", cwd, ["var", "GIT_CONFIG_SYSTEM"]),
      ],
      { concurrency: 2 },
    );
    const globalFiles = configFiles(globalResult);
    const systemFiles = configFiles(systemResult);
    if (globalFiles === null || systemFiles === null) return null;
    if (configFileLocations.size >= CONFIG_FILE_LOCATIONS_CAPACITY) configFileLocations.clear();
    const files = [...globalFiles, ...systemFiles];
    configFileLocations.set(environment, files);
    return files;
  });

  const readConfigState = Effect.fn("GitVcsDriver.configSnapshot.read")(function* (
    cwd: string,
    environment: string,
    home: string | undefined,
  ) {
    const pathsResult = yield* runGit(
      "GitVcsDriver.configSnapshot.paths",
      cwd,
      REPOSITORY_PATH_ARGS,
    );
    if (pathsResult.exitCode !== 0) return null;
    const lines = pathsResult.stdout.split("\n");
    // Git before 2.31 echoes --path-format; a path containing a newline spans lines.
    if (lines[0] === "--path-format=absolute") {
      supported = false;
      return null;
    }
    const paths = lines.slice(0, REPOSITORY_PATH_COUNT);
    const prefix = lines[REPOSITORY_PATH_COUNT];
    if (
      lines.length !== REPOSITORY_PATH_COUNT + 2 ||
      prefix === undefined ||
      lines.at(-1) !== "" ||
      !paths.every((line) => line.length > 0 && path.isAbsolute(line))
    ) {
      return null;
    }
    const [
      toplevel,
      gitDir,
      config,
      configWorktree,
      commondir,
      remotes,
      branches,
      head,
      objects,
      refs,
    ] = paths as [string, string, string, string, string, string, string, string, string, string];
    const segments = prefix.split("/").filter((segment) => segment.length > 0);
    const [locations, listResult, remoteFiles, branchFiles, insideTopLevel] = yield* Effect.all(
      [
        readConfigFileLocations(cwd, environment),
        runGit("GitVcsDriver.configSnapshot.list", cwd, [
          "config",
          "--list",
          "--show-origin",
          "-z",
        ]),
        listDirectory(remotes),
        listDirectory(branches),
        isSameFile(cwd, path.join(toplevel, ...segments)),
      ],
      { concurrency: "unbounded" },
    );
    // A directory outside the work tree (GIT_WORK_TREE elsewhere) has no prefix to walk.
    if (locations === null || !insideTopLevel) return null;

    // Discovery: the directory, what would make Git stop below the top level (a `.git`, or HEAD of a
    // bare repository), the `.git` it found, what keeps that a repository, and the top level and git
    // dir whose owners safe.directory checks. The prefix comes from Git, cased as on disk like the
    // top level, whatever case the directory was given in.
    const dependencies: GitConfigDependency[] = [{ path: cwd, kind: "identity" }];
    for (let depth = segments.length; depth > 0; depth--) {
      const directory = path.join(toplevel, ...segments.slice(0, depth));
      dependencies.push(
        { path: path.join(directory, ".git"), kind: "absent" },
        { path: path.join(directory, "HEAD"), kind: "absent" },
      );
    }
    dependencies.push(
      { path: path.join(toplevel, ".git"), kind: "identity" },
      { path: toplevel, kind: "identity" },
      { path: gitDir, kind: "identity" },
      { path: head, kind: "content" },
      { path: objects, kind: "presence" },
      { path: refs, kind: "presence" },
    );
    const files = [
      config,
      configWorktree,
      commondir,
      remotes,
      ...remoteFiles,
      branches,
      ...branchFiles,
      ...locations,
    ];
    let snapshotSupported = locations.every((file) => path.isAbsolute(file));
    const entries =
      listResult.exitCode === 0 && !listResult.stdoutTruncated
        ? parseGitConfigList(listResult.stdout)
        : null;
    if (entries === null) {
      snapshotSupported = false;
    } else {
      const listed = gitConfigListDependencies(entries, {
        home,
        windows,
        isAbsolute: path.isAbsolute,
      });
      files.push(...listed.paths);
      snapshotSupported &&= listed.supported;
    }
    for (const file of files) dependencies.push({ path: file, kind: "content" });
    const values = new Map<string, string | null>();
    for (const entry of entries ?? []) values.set(entry.key, entry.value);
    return { dependencies, values: snapshotSupported ? values : null };
  });

  const load = Effect.fn("GitVcsDriver.configSnapshot.load")(
    function* (key: string) {
      const separator = key.indexOf("\0");
      const environment = key.slice(0, separator);
      const cwd = key.slice(separator + 1);
      // Git runs in the environment of the read that started the load, which the key names.
      const env = yield* HostProcess.Environment;
      if (gitConfigEnvironmentSignature(env) !== environment) return null;
      let dependencies = reloadDependencies.get(key) ?? [];
      reloadDependencies.delete(key);
      for (let attempt = 0; attempt < CONFIG_SNAPSHOT_LOAD_ATTEMPTS; attempt++) {
        const fingerprints = yield* fingerprintDependencies(dependencies);
        const state = yield* readConfigState(cwd, environment, env.HOME);
        if (state === null) return null;
        const fingerprintByKey = new Map(
          dependencies.map((dependency, index) => [
            dependencyKey(dependency),
            fingerprints[index]!,
          ]),
        );
        const unique = [
          ...new Map(
            state.dependencies.map((dependency) => [dependencyKey(dependency), dependency]),
          ),
        ].map(([, dependency]) => dependency);
        if (unique.every((dependency) => fingerprintByKey.has(dependencyKey(dependency)))) {
          const fingerprint = unique.map((dependency) =>
            fingerprintByKey.get(dependencyKey(dependency))!,
          );
          const discovered = unique.every(
            (dependency, index) =>
              dependency.kind !== "absent" || fingerprint[index]!.startsWith("!"),
          );
          return {
            dependencies: unique,
            fingerprint: fingerprint.join("\n"),
            snapshot:
              state.values === null || !discovered
                ? null
                : { values: state.values, results: new Map() },
          } satisfies CachedGitConfigSnapshot;
        }
        // Something was read before it was stat'ed; stat it and read again.
        dependencies = unique;
      }
      return null;
    },
    Effect.catchTags({ GitCommandError: () => Effect.succeed(null) }),
  );

  const snapshots = yield* Cache.makeWith(load, {
    capacity: CONFIG_SNAPSHOT_CACHE_CAPACITY,
    timeToLive: (exit) =>
      Exit.isSuccess(exit) && exit.value !== null ? Duration.infinity : CONFIG_SNAPSHOT_RETRY_TTL,
  });

  const isCurrent = (cached: CachedGitConfigSnapshot) =>
    fingerprintDependencies(cached.dependencies).pipe(
      Effect.map((fingerprints) => fingerprints.join("\n") === cached.fingerprint),
    );

  // A one-off read runs one command; a directory read again, such as on every refresh, is loaded.
  const isReadAgain = (key: string) => {
    if (readOnce.has(key)) return true;
    if (readOnce.size >= CONFIG_SNAPSHOT_CACHE_CAPACITY) {
      readOnce.delete(readOnce.values().next().value!);
    }
    readOnce.add(key);
    return false;
  };

  /**
   * The current snapshot for `cwd` in this read's environment, or null when this read must run Git.
   * Untraced: it runs on every config read, several per status refresh; loads keep their spans.
   */
  const read = Effect.fnUntraced(function* (cwd: string) {
    if (!supported) return null;
    const environment = gitConfigEnvironmentSignature(yield* HostProcess.Environment);
    if (environment === null) return null;
    const key = snapshotKey(cwd, environment);
    // Background work only reuses a current snapshot: a load in its small lane would hold up the
    // reads that wait for it.
    if (yield* GitVcsDriver.BackgroundGitWork) {
      const cached = Option.getOrNull(yield* Cache.getOption(snapshots, key));
      return cached !== null && (yield* isCurrent(cached)) ? cached.snapshot : null;
    }
    if (!(yield* Cache.has(snapshots, key)) && !isReadAgain(key)) return null;
    const cached = yield* Cache.get(snapshots, key);
    if (cached === null) return null;
    if (yield* isCurrent(cached)) return cached.snapshot;
    reloadDependencies.set(key, cached.dependencies);
    yield* Cache.invalidateWhen(snapshots, key, (current) => current === cached);
    // Whatever replaces the stale entry loaded after this read began, so it needs no check.
    const reloaded = yield* Cache.get(snapshots, key);
    reloadDependencies.delete(key);
    return reloaded?.snapshot ?? null;
  });

  return { read };
});

/**
 * Runs a command whose result depends only on config (such as `git remote`) once per snapshot.
 * Exit codes from 128 up are fatal errors or signals that a later run could avoid, so they rerun.
 */
export const runWithGitConfigSnapshot = (
  snapshot: GitConfigSnapshot | null,
  args: ReadonlyArray<string>,
  run: Effect.Effect<GitVcsDriver.ExecuteGitResult, GitCommandError>,
): Effect.Effect<GitVcsDriver.ExecuteGitResult, GitCommandError> => {
  if (snapshot === null) return run;
  const key = args.join("\0");
  const reused = snapshot.results.get(key);
  if (reused !== undefined) return Effect.succeed(reused);
  return run.pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        if (
          result.exitCode !== null &&
          result.exitCode < 128 &&
          !result.stdoutTruncated &&
          !result.stderrTruncated
        ) {
          if (snapshot.results.size >= REUSED_RESULTS_CAPACITY) {
            snapshot.results.delete(snapshot.results.keys().next().value!);
          }
          snapshot.results.set(key, result);
        }
      }),
    ),
  );
};
