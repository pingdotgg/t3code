import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  VcsProcessExitError,
  type VcsError,
  type VcsFreshness,
  type VcsRemote,
} from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { type IgnoreFile, parseIgnoreFile } from "../workspace/IgnorePatterns.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

const WORKSPACE_FILES_MAX_COUNT = 100_000;
const CHECKPOINT_REFS_FILENAME = "t3-checkpoints.json";
const INTERNAL_VCS_DIRS = new Set([".git", ".gitx"]);

const GitxWorkspacePointer = Schema.Struct({
  gitx_dir: Schema.optional(Schema.String),
});
const decodeWorkspacePointer = Schema.decodeUnknownEffect(fromLenientJson(GitxWorkspacePointer));

const GitxCheckpointRecord = Schema.Struct({
  revision: Schema.String,
  opId: Schema.NullOr(Schema.String),
  capturedAt: Schema.String,
  head: Schema.String,
});
type GitxCheckpointRecord = typeof GitxCheckpointRecord.Type;

const GitxCheckpointStoreFile = Schema.Record(Schema.String, GitxCheckpointRecord);
const decodeCheckpointStore = Schema.decodeUnknownEffect(fromLenientJson(GitxCheckpointStoreFile));
const encodeCheckpointStore = Schema.encodeEffect(Schema.fromJsonString(GitxCheckpointStoreFile));

interface ParsedGitxStatus {
  readonly revision: string | null;
  readonly clean: boolean;
}

interface ParsedDiffSection {
  readonly path: string;
  readonly patch: string;
  readonly binary: boolean;
  readonly additions: number;
  readonly deletions: number;
}

const nowFreshness = (): Effect.Effect<VcsFreshness> =>
  DateTime.now.pipe(
    Effect.map((observedAt) => ({
      source: "live-local" as const,
      observedAt,
      expiresAt: Option.none(),
    })),
  );

function normalizePosixPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

export function parseGitxRemoteListOutput(stdout: string): ReadonlyArray<VcsRemote> {
  const trimmed = stdout.trim();
  if (trimmed.length === 0 || trimmed === "No remotes configured.") {
    return [];
  }

  const remotes: VcsRemote[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const tabIndex = line.indexOf("\t");
    if (tabIndex <= 0) continue;
    const name = line.slice(0, tabIndex).trim();
    const rest = line.slice(tabIndex + 1).trim();
    const metaIndex = rest.indexOf(" (owner=");
    const url = (metaIndex === -1 ? rest : rest.slice(0, metaIndex)).trim();
    if (name.length === 0 || url.length === 0) continue;
    remotes.push({
      name,
      url,
      pushUrl: Option.none(),
      isPrimary: name === "origin",
    });
  }
  return remotes;
}

export function parseGitxStatusOutput(stdout: string): ParsedGitxStatus {
  let revision: string | null = null;
  let inChangesSection = false;
  let sawNoChanges = false;
  let sawChangeLine = false;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const revMatch = /^Revision:\s+(\S+)/.exec(rawLine);
    if (revMatch?.[1]) {
      revision = revMatch[1];
      continue;
    }
    if (rawLine.startsWith("Changes vs parent:")) {
      inChangesSection = true;
      continue;
    }
    if (inChangesSection) {
      const trimmed = rawLine.trim();
      if (trimmed.length === 0) {
        inChangesSection = false;
        continue;
      }
      if (trimmed === "(no changes)") {
        sawNoChanges = true;
      } else {
        sawChangeLine = true;
      }
    }
  }

  return {
    revision,
    clean: sawNoChanges && !sawChangeLine,
  };
}

export function parseGitxOpLogLatestId(stdout: string): string | null {
  const firstLine = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine || firstLine === "Operation log is empty.") {
    return null;
  }
  const match = /^([0-9a-zA-Z]+)\s+\d{4}-\d{2}-\d{2}\s+/.exec(firstLine);
  return match?.[1] ?? null;
}

export function parseGitxUnifiedDiffSections(stdout: string): ReadonlyArray<ParsedDiffSection> {
  const trimmed = stdout.trim();
  if (trimmed.length === 0 || trimmed === "(no differences)") {
    return [];
  }

  const lines = stdout.split(/\r?\n/);
  const sections: ParsedDiffSection[] = [];

  const flushSection = (
    filePath: string | null,
    sectionLines: ReadonlyArray<string>,
    binary: boolean,
  ) => {
    if (filePath === null || filePath.length === 0) return;
    let additions = 0;
    let deletions = 0;
    let inHunk = false;
    for (const line of sectionLines) {
      if (line.startsWith("@@ ")) {
        inHunk = true;
        continue;
      }
      if (!inHunk) continue;
      if (line.startsWith("+") && !line.startsWith("+++ ")) additions += 1;
      else if (line.startsWith("-") && !line.startsWith("--- ")) deletions += 1;
    }
    const hasGitHeader = sectionLines[0]?.startsWith("diff --git ");
    const body = sectionLines.join("\n");
    const patch = hasGitHeader ? `${body}\n` : `diff --git a/${filePath} b/${filePath}\n${body}\n`;
    sections.push({
      path: filePath,
      patch,
      binary,
      additions,
      deletions,
    });
  };

  let currentPath: string | null = null;
  let currentLines: string[] = [];
  let currentBinary = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const binaryMatch = /^Binary files a\/(.+) and b\/(.+) differ$/.exec(line);
    if (binaryMatch?.[2]) {
      flushSection(currentPath, currentLines, currentBinary);
      currentPath = normalizePosixPath(binaryMatch[2]);
      currentLines = [line];
      currentBinary = true;
      continue;
    }

    if (line.startsWith("--- a/") && lines[index + 1]?.startsWith("+++ b/")) {
      flushSection(currentPath, currentLines, currentBinary);
      const nextLine = lines[index + 1]!;
      currentPath = normalizePosixPath(nextLine.slice("+++ b/".length));
      currentLines = [line, nextLine];
      currentBinary = false;
      index += 1;
      continue;
    }

    if (currentPath !== null) {
      if (index === lines.length - 1 && line === "") continue;
      currentLines.push(line);
    }
  }

  flushSection(currentPath, currentLines, currentBinary);
  return sections;
}

function isPathExcluded(
  relativePath: string,
  excludePaths: ReadonlyArray<string> | undefined,
): boolean {
  if (!excludePaths || excludePaths.length === 0) return false;
  return excludePaths.some((rawExcluded) => {
    const excluded = normalizePosixPath(rawExcluded).replace(/\/+$/, "");
    if (excluded.length === 0) return false;
    return relativePath === excluded || relativePath.startsWith(`${excluded}/`);
  });
}

function filterDiffSections(
  sections: ReadonlyArray<ParsedDiffSection>,
  filePaths: ReadonlyArray<string> | undefined,
  excludePaths: ReadonlyArray<string> | undefined,
): ReadonlyArray<ParsedDiffSection> {
  const allowed =
    filePaths === undefined ? null : new Set(filePaths.map((entry) => normalizePosixPath(entry)));
  return sections.filter((section) => {
    if (allowed !== null && !allowed.has(section.path)) return false;
    return !isPathExcluded(section.path, excludePaths);
  });
}

export function formatGitxPatch(
  stdout: string,
  options?: {
    readonly filePaths?: ReadonlyArray<string>;
    readonly excludePaths?: ReadonlyArray<string>;
  },
): string {
  const sections = filterDiffSections(
    parseGitxUnifiedDiffSections(stdout),
    options?.filePaths,
    options?.excludePaths,
  );
  return sections.map((section) => section.patch).join("");
}

export function formatGitxNumstat(
  stdout: string,
  options?: {
    readonly filePaths?: ReadonlyArray<string>;
    readonly excludePaths?: ReadonlyArray<string>;
  },
): string {
  const sections = filterDiffSections(
    parseGitxUnifiedDiffSections(stdout),
    options?.filePaths,
    options?.excludePaths,
  );
  return sections
    .map((section) =>
      section.binary
        ? `-\t-\t${section.path}\0`
        : `${section.additions}\t${section.deletions}\t${section.path}\0`,
    )
    .join("");
}

interface ScopedIgnoreMatcher {
  readonly basePrefix: string;
  readonly matcher: IgnoreFile;
}

function isIgnoredByMatchers(
  matchers: ReadonlyArray<ScopedIgnoreMatcher>,
  relativePath: string,
  isFolder: boolean,
): boolean {
  let ignored = false;
  for (const { basePrefix, matcher } of matchers) {
    let scopedPath: string;
    if (basePrefix === "") {
      scopedPath = relativePath;
    } else if (relativePath.startsWith(`${basePrefix}/`)) {
      scopedPath = relativePath.slice(basePrefix.length + 1);
    } else {
      continue;
    }
    const decision = matcher.decide(scopedPath, isFolder);
    if (decision === "ignored") ignored = true;
    else if (decision === "included") ignored = false;
  }
  return ignored;
}

const gitxCommand = Effect.fn("GitxVcsDriver.gitxCommand")(
  (
    process: VcsProcess.VcsProcess["Service"],
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    options?: {
      readonly stdin?: string;
      readonly onSpawn?: () => void;
      readonly env?: NodeJS.ProcessEnv;
      readonly allowNonZeroExit?: boolean;
      readonly timeoutMs?: number;
      readonly maxOutputBytes?: number;
      readonly outputMode?: VcsProcess.VcsProcessInput["outputMode"];
      readonly appendTruncationMarker?: boolean;
    },
  ) =>
    process.run({
      operation,
      command: "gitx",
      args,
      cwd,
      ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options?.onSpawn !== undefined ? { onSpawn: options.onSpawn } : {}),
      ...(options?.env !== undefined ? { env: options.env } : {}),
      ...(options?.allowNonZeroExit !== undefined
        ? { allowNonZeroExit: options.allowNonZeroExit }
        : {}),
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options?.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
      ...(options?.outputMode !== undefined ? { outputMode: options.outputMode } : {}),
      ...(options?.appendTruncationMarker !== undefined
        ? { appendTruncationMarker: options.appendTruncationMarker }
        : {}),
    }),
);

export const makeVcsDriver = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const checkpointLocks = new Map<string, Semaphore.Semaphore>();

  const withCheckpointLock = <A, E, R>(metadataPath: string, effect: Effect.Effect<A, E, R>) => {
    let lock = checkpointLocks.get(metadataPath);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      checkpointLocks.set(metadataPath, lock);
    }
    return lock.withPermits(1)(effect);
  };

  const existsSafe = (target: string) =>
    fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false));

  const readIgnoreMatchersForDir = (
    dirPath: string,
    basePrefix: string,
  ): Effect.Effect<ReadonlyArray<ScopedIgnoreMatcher>> =>
    Effect.forEach([".gitignore", ".gitxignore"], (fileName) =>
      fileSystem.readFileString(path.join(dirPath, fileName)).pipe(
        Effect.map((contents) => ({ basePrefix, matcher: parseIgnoreFile(contents) })),
        Effect.orElseSucceed(() => null),
      ),
    ).pipe(Effect.map((entries) => entries.filter((entry) => entry !== null)));

  const execute: VcsDriver.VcsDriver["Service"]["execute"] = (input) =>
    gitxCommand(vcsProcess, input.operation, input.cwd, input.args, {
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      ...(input.onSpawn !== undefined ? { onSpawn: input.onSpawn } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.allowNonZeroExit !== undefined ? { allowNonZeroExit: input.allowNonZeroExit } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
      ...(input.outputMode !== undefined ? { outputMode: input.outputMode } : {}),
      ...(input.appendTruncationMarker !== undefined
        ? { appendTruncationMarker: input.appendTruncationMarker }
        : {}),
    });

  const detectRepository: VcsDriver.VcsDriver["Service"]["detectRepository"] = Effect.fn(
    "GitxVcsDriver.detectRepository",
  )(function* (cwd) {
    const resolvedCwd = path.resolve(cwd);
    if (!(yield* existsSafe(resolvedCwd))) {
      return null;
    }

    let current = resolvedCwd;
    while (true) {
      const gitxDir = path.join(current, ".gitx");
      if (yield* existsSafe(path.join(gitxDir, "config.json"))) {
        return {
          kind: "gitx" as const,
          rootPath: current,
          metadataPath: gitxDir,
          freshness: yield* nowFreshness(),
        };
      }

      const workspacePointerPath = path.join(gitxDir, "workspace.json");
      if (yield* existsSafe(workspacePointerPath)) {
        const pointerMetadata = yield* fileSystem.readFileString(workspacePointerPath).pipe(
          Effect.flatMap((raw) => decodeWorkspacePointer(raw)),
          Effect.map((pointer) =>
            pointer.gitx_dir && pointer.gitx_dir.trim().length > 0 ? pointer.gitx_dir : gitxDir,
          ),
          Effect.orElseSucceed(() => gitxDir),
        );
        return {
          kind: "gitx" as const,
          rootPath: current,
          metadataPath: pointerMetadata,
          freshness: yield* nowFreshness(),
        };
      }

      const parent = path.dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  });

  const isInsideWorkTree: VcsDriver.VcsDriver["Service"]["isInsideWorkTree"] = Effect.fn(
    "GitxVcsDriver.isInsideWorkTree",
  )(function* (cwd) {
    return (yield* detectRepository(cwd)) !== null;
  });

  const listWorkspaceFiles: VcsDriver.VcsDriver["Service"]["listWorkspaceFiles"] = Effect.fn(
    "GitxVcsDriver.listWorkspaceFiles",
  )(function* (cwd) {
    const resolvedCwd = path.resolve(cwd);
    const repository = yield* detectRepository(resolvedCwd);
    const scanRoot = resolvedCwd;
    const repoRoot = repository?.rootPath ?? resolvedCwd;

    // Collect ignore rules from repo root down to cwd when invoked in a nested directory.
    const ancestorMatchers: ScopedIgnoreMatcher[] = [];
    const relativeToRoot = normalizePosixPath(path.relative(repoRoot, scanRoot));
    if (
      relativeToRoot !== "" &&
      relativeToRoot !== ".." &&
      !relativeToRoot.startsWith("../") &&
      !path.isAbsolute(relativeToRoot)
    ) {
      const rootMatchers = yield* readIgnoreMatchersForDir(repoRoot, "");
      ancestorMatchers.push(...rootMatchers);
      const segments = relativeToRoot.split("/");
      let prefix = "";
      for (let index = 0; index < segments.length - 1; index += 1) {
        prefix = prefix === "" ? segments[index]! : `${prefix}/${segments[index]!}`;
        const nested = yield* readIgnoreMatchersForDir(path.join(repoRoot, prefix), prefix);
        ancestorMatchers.push(...nested);
      }
    }

    const paths: string[] = [];
    let truncated = false;

    // Per-directory recursion shares the enclosing listWorkspaceFiles span.
    const walk = Effect.fnUntraced(function* walkDir(
      absDir: string,
      relToCwd: string,
      relToRoot: string,
      matchers: ReadonlyArray<ScopedIgnoreMatcher>,
    ): Effect.fn.Return<void, never> {
      if (truncated) return;
      const localMatchers = yield* readIgnoreMatchersForDir(absDir, relToRoot);
      const activeMatchers =
        localMatchers.length === 0 ? matchers : [...matchers, ...localMatchers];
      const entries = yield* fileSystem
        .readDirectory(absDir)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

      for (const name of entries.toSorted()) {
        if (truncated) return;
        if (INTERNAL_VCS_DIRS.has(name)) continue;

        const childAbs = path.join(absDir, name);
        const childRelCwd = relToCwd === "" ? name : `${relToCwd}/${name}`;
        const childRelRoot = relToRoot === "" ? name : `${relToRoot}/${name}`;
        const info = yield* fileSystem.stat(childAbs).pipe(Effect.orElseSucceed(() => null));
        if (info === null) continue;

        const isDir = info.type === "Directory";
        if (isIgnoredByMatchers(activeMatchers, childRelRoot, isDir)) {
          continue;
        }

        if (isDir) {
          yield* walkDir(childAbs, childRelCwd, childRelRoot, activeMatchers);
        } else {
          if (paths.length >= WORKSPACE_FILES_MAX_COUNT) {
            truncated = true;
            return;
          }
          paths.push(childRelCwd);
        }
      }
    });

    const initialRelRoot =
      relativeToRoot === "" || relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)
        ? ""
        : relativeToRoot;
    yield* walk(scanRoot, "", initialRelRoot, ancestorMatchers);

    return {
      paths,
      truncated,
      freshness: yield* nowFreshness(),
    };
  });

  const filterIgnoredPaths: VcsDriver.VcsDriver["Service"]["filterIgnoredPaths"] = Effect.fn(
    "GitxVcsDriver.filterIgnoredPaths",
  )(function* (cwd, relativePaths) {
    if (relativePaths.length === 0) {
      return relativePaths;
    }

    const resolvedCwd = path.resolve(cwd);
    const repository = yield* detectRepository(resolvedCwd);
    const repoRoot = repository?.rootPath ?? resolvedCwd;
    const relCwdToRoot = normalizePosixPath(path.relative(repoRoot, resolvedCwd));
    const cwdPrefix =
      relCwdToRoot === "" || relCwdToRoot.startsWith("..") || path.isAbsolute(relCwdToRoot)
        ? ""
        : relCwdToRoot;

    const dirMatchersCache = new Map<string, ReadonlyArray<ScopedIgnoreMatcher>>();
    // Per-directory cache lookup shares the enclosing filterIgnoredPaths span.
    const loadDirMatchers = Effect.fnUntraced(function* (relDirFromRoot: string) {
      const cached = dirMatchersCache.get(relDirFromRoot);
      if (cached !== undefined) return cached;
      const absDir = relDirFromRoot === "" ? repoRoot : path.join(repoRoot, relDirFromRoot);
      const loaded = yield* readIgnoreMatchersForDir(absDir, relDirFromRoot);
      dirMatchersCache.set(relDirFromRoot, loaded);
      return loaded;
    });

    const kept: string[] = [];
    for (const rawPath of relativePaths) {
      const normalized = normalizePosixPath(rawPath);
      const segments = normalized.split("/");
      if (segments.some((segment) => INTERNAL_VCS_DIRS.has(segment))) {
        continue;
      }

      const fullRelFromRoot = cwdPrefix === "" ? normalized : `${cwdPrefix}/${normalized}`;
      const fullSegments = fullRelFromRoot.split("/");
      const matchers: ScopedIgnoreMatcher[] = [];
      matchers.push(...(yield* loadDirMatchers("")));
      let dirPrefix = "";
      for (let index = 0; index < fullSegments.length - 1; index += 1) {
        dirPrefix =
          dirPrefix === "" ? fullSegments[index]! : `${dirPrefix}/${fullSegments[index]!}`;
        matchers.push(...(yield* loadDirMatchers(dirPrefix)));
      }

      let ignored = false;
      let ancestorPath = "";
      for (let index = 0; index < fullSegments.length - 1; index += 1) {
        ancestorPath =
          ancestorPath === "" ? fullSegments[index]! : `${ancestorPath}/${fullSegments[index]!}`;
        if (isIgnoredByMatchers(matchers, ancestorPath, true)) {
          ignored = true;
          break;
        }
      }
      if (!ignored && isIgnoredByMatchers(matchers, fullRelFromRoot, false)) {
        ignored = true;
      }

      if (!ignored) {
        kept.push(rawPath);
      }
    }

    return kept;
  });

  const listRemotes: VcsDriver.VcsDriver["Service"]["listRemotes"] = Effect.fn(
    "GitxVcsDriver.listRemotes",
  )(function* (cwd) {
    const result = yield* gitxCommand(
      vcsProcess,
      "GitxVcsDriver.listRemotes",
      cwd,
      ["remote", "list"],
      {
        allowNonZeroExit: true,
        timeoutMs: 5_000,
        maxOutputBytes: 64 * 1024,
      },
    );

    if (result.exitCode !== 0) {
      return yield* new VcsProcessExitError({
        operation: "GitxVcsDriver.listRemotes",
        command: "gitx remote list",
        cwd,
        exitCode: result.exitCode,
        detail: result.stderr.trim() || "gitx remote list failed",
      });
    }

    return {
      remotes: parseGitxRemoteListOutput(result.stdout),
      freshness: yield* nowFreshness(),
    };
  });

  const initRepository: VcsDriver.VcsDriver["Service"]["initRepository"] = Effect.fn(
    "GitxVcsDriver.initRepository",
  )(function* (input) {
    const hasGitDir = yield* existsSafe(path.join(input.cwd, ".git"));
    yield* gitxCommand(
      vcsProcess,
      "GitxVcsDriver.initRepository",
      input.cwd,
      hasGitDir ? ["init", "--colocate"] : ["init"],
      {
        timeoutMs: 10_000,
        maxOutputBytes: 64 * 1024,
      },
    );
  });

  const resolveMetadataDir = (operation: string, cwd: string) =>
    detectRepository(cwd).pipe(
      Effect.flatMap((identity) =>
        identity?.metadataPath
          ? Effect.succeed(identity.metadataPath)
          : Effect.fail(
              new VcsProcessExitError({
                operation,
                command: "gitx",
                cwd,
                exitCode: 1,
                detail: "Not inside a GitX repository.",
              }),
            ),
      ),
    );

  const readCheckpointStore = (
    metadataPath: string,
  ): Effect.Effect<Record<string, GitxCheckpointRecord>> =>
    fileSystem.readFileString(path.join(metadataPath, CHECKPOINT_REFS_FILENAME)).pipe(
      Effect.flatMap((raw) => decodeCheckpointStore(raw)),
      Effect.map((records) => ({ ...records })),
      Effect.orElseSucceed((): Record<string, GitxCheckpointRecord> => ({})),
    );

  const writeCheckpointStore = Effect.fn("GitxVcsDriver.writeCheckpointStore")(function* (
    operation: string,
    cwd: string,
    metadataPath: string,
    records: Record<string, GitxCheckpointRecord>,
  ): Effect.fn.Return<void, VcsError> {
    const targetPath = path.join(metadataPath, CHECKPOINT_REFS_FILENAME);
    const nowMillis = yield* Clock.currentTimeMillis;
    const tempPath = `${targetPath}.${nowMillis}.tmp`;
    const encoded = yield* encodeCheckpointStore(records).pipe(
      Effect.mapError(
        (cause) =>
          new VcsProcessExitError({
            operation,
            command: "gitx checkpoint",
            cwd,
            exitCode: 1,
            detail: `Failed to encode GitX checkpoint metadata: ${cause.message}`,
          }),
      ),
    );
    yield* fileSystem.writeFileString(tempPath, `${encoded}\n`).pipe(
      Effect.andThen(fileSystem.rename(tempPath, targetPath)),
      Effect.mapError(
        (cause) =>
          new VcsProcessExitError({
            operation,
            command: "gitx checkpoint",
            cwd,
            exitCode: 1,
            detail: `Failed to persist GitX checkpoint metadata: ${cause.message}`,
          }),
      ),
    );
  });

  const readLatestOpId = (operation: string, cwd: string) =>
    gitxCommand(vcsProcess, operation, cwd, ["op", "log", "--limit", "1"], {
      allowNonZeroExit: true,
      timeoutMs: 5_000,
      maxOutputBytes: 16 * 1024,
    }).pipe(
      Effect.map((result) =>
        result.exitCode === 0 ? parseGitxOpLogLatestId(result.stdout) : null,
      ),
      Effect.orElseSucceed(() => null),
    );

  const snapshotCurrentRevision = (operation: string, cwd: string) =>
    gitxCommand(vcsProcess, operation, cwd, ["status"], {
      timeoutMs: 15_000,
      maxOutputBytes: 256 * 1024,
    }).pipe(
      Effect.flatMap((result) => {
        const parsed = parseGitxStatusOutput(result.stdout);
        if (parsed.revision === null) {
          return Effect.fail(
            new VcsProcessExitError({
              operation,
              command: "gitx status",
              cwd,
              exitCode: 0,
              detail: "gitx status did not report a revision hash.",
            }),
          );
        }
        return Effect.succeed({ revision: parsed.revision, clean: parsed.clean });
      }),
    );

  const checkpoints: VcsDriver.VcsCheckpointOps = {
    captureCheckpoint: Effect.fn("GitxVcsDriver.checkpoints.captureCheckpoint")(function* (input) {
      const operation = "GitxVcsDriver.checkpoints.captureCheckpoint";
      const metadataPath = yield* resolveMetadataDir(operation, input.cwd);
      const { revision } = yield* snapshotCurrentRevision(operation, input.cwd);
      const opId = yield* readLatestOpId(operation, input.cwd);
      const capturedAt = String(Math.floor((yield* Clock.currentTimeMillis) / 1000));

      return yield* withCheckpointLock(
        metadataPath,
        Effect.gen(function* () {
          const store = yield* readCheckpointStore(metadataPath);
          const previous =
            input.previousCheckpointRef === undefined
              ? undefined
              : store[input.previousCheckpointRef];

          store[input.checkpointRef] = {
            revision,
            opId,
            capturedAt,
            head: revision,
          };
          yield* writeCheckpointStore(operation, input.cwd, metadataPath, store);

          if (previous === undefined) {
            return null;
          }
          return {
            from: previous.revision,
            to: revision,
            fromCapturedAt: previous.capturedAt,
            startHead: previous.head,
            endHead: revision,
            unchanged: previous.revision === revision,
          } satisfies VcsDriver.VcsCheckpointRange;
        }),
      );
    }),

    resolveCleanHead: Effect.fn("GitxVcsDriver.checkpoints.resolveCleanHead")(function* (cwd) {
      const result = yield* gitxCommand(
        vcsProcess,
        "GitxVcsDriver.checkpoints.resolveCleanHead",
        cwd,
        ["status"],
        {
          allowNonZeroExit: true,
          timeoutMs: 10_000,
          maxOutputBytes: 64 * 1024,
        },
      );
      if (result.exitCode !== 0 || result.stdoutTruncated) {
        return null;
      }
      const parsed = parseGitxStatusOutput(result.stdout);
      return parsed.clean ? parsed.revision : null;
    }),

    captureHeadCheckpoint: Effect.fn("GitxVcsDriver.checkpoints.captureHeadCheckpoint")(
      function* (input) {
        const operation = "GitxVcsDriver.checkpoints.captureHeadCheckpoint";
        const metadataPath = yield* resolveMetadataDir(operation, input.cwd);
        const opId = yield* readLatestOpId(operation, input.cwd);
        const capturedAt = String(
          input.seenAt ?? Math.floor((yield* Clock.currentTimeMillis) / 1000),
        );

        yield* withCheckpointLock(
          metadataPath,
          Effect.gen(function* () {
            const store = yield* readCheckpointStore(metadataPath);
            store[input.checkpointRef] = {
              revision: input.head,
              opId,
              capturedAt,
              head: input.head,
            };
            yield* writeCheckpointStore(operation, input.cwd, metadataPath, store);
          }),
        );
      },
    ),

    hasCheckpointRef: Effect.fn("GitxVcsDriver.checkpoints.hasCheckpointRef")(function* (input) {
      const repository = yield* detectRepository(input.cwd);
      if (!repository?.metadataPath) return false;
      const store = yield* readCheckpointStore(repository.metadataPath);
      return Object.hasOwn(store, input.checkpointRef);
    }),

    restoreCheckpoint: Effect.fn("GitxVcsDriver.checkpoints.restoreCheckpoint")(function* (input) {
      const operation = "GitxVcsDriver.checkpoints.restoreCheckpoint";
      const metadataPath = yield* resolveMetadataDir(operation, input.cwd);
      const store = yield* readCheckpointStore(metadataPath);
      const record = store[input.checkpointRef];
      const opId =
        record?.opId ??
        (input.fallbackToHead === true ? yield* readLatestOpId(operation, input.cwd) : null);

      if (!opId) {
        return false;
      }

      yield* gitxCommand(vcsProcess, operation, input.cwd, ["op", "restore", opId], {
        timeoutMs: 15_000,
        maxOutputBytes: 64 * 1024,
      });
      return true;
    }),

    diffCheckpoints: Effect.fn("GitxVcsDriver.checkpoints.diffCheckpoints")(function* (input) {
      const operation = "GitxVcsDriver.checkpoints.diffCheckpoints";
      if (input.filePaths?.length === 0) return "";

      const metadataPath = yield* resolveMetadataDir(operation, input.cwd);
      const store = yield* readCheckpointStore(metadataPath);

      let fromRev = input.range?.from ?? store[input.fromCheckpointRef]?.revision;
      if (fromRev === undefined && input.fallbackFromToHead === true) {
        const snapshot = yield* snapshotCurrentRevision(operation, input.cwd);
        fromRev = snapshot.revision;
      }
      const toRev = input.range?.to ?? store[input.toCheckpointRef]?.revision;

      if (fromRev === undefined || toRev === undefined) {
        return yield* new VcsProcessExitError({
          operation,
          command: "gitx diff",
          cwd: input.cwd,
          exitCode: 1,
          detail: "Checkpoint ref is unavailable for diff operation.",
        });
      }

      if (fromRev === toRev) {
        return "";
      }

      const result = yield* gitxCommand(
        vcsProcess,
        operation,
        input.cwd,
        ["diff", "--from", fromRev, "--to", toRev],
        {
          allowNonZeroExit: true,
          maxOutputBytes: input.maxOutputBytes ?? VcsDriver.CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
          outputMode: input.format === "numstat" ? "error" : "truncate",
        },
      );

      if (result.exitCode !== 0) {
        return yield* new VcsProcessExitError({
          operation,
          command: "gitx diff",
          cwd: input.cwd,
          exitCode: result.exitCode,
          detail: result.stderr.trim() || "Checkpoint ref is unavailable for diff operation.",
        });
      }

      const filterOptions = {
        ...(input.filePaths !== undefined ? { filePaths: input.filePaths } : {}),
        ...(input.excludePaths !== undefined ? { excludePaths: input.excludePaths } : {}),
      };
      return input.format === "numstat"
        ? formatGitxNumstat(result.stdout, filterOptions)
        : formatGitxPatch(result.stdout, filterOptions);
    }),

    listAuthoredPaths: () => Effect.succeed(null),

    deleteCheckpointRefs: Effect.fn("GitxVcsDriver.checkpoints.deleteCheckpointRefs")(
      function* (input) {
        if (input.checkpointRefs.length === 0) return;
        const operation = "GitxVcsDriver.checkpoints.deleteCheckpointRefs";
        const repository = yield* detectRepository(input.cwd);
        if (!repository?.metadataPath) return;
        const metadataPath = repository.metadataPath;

        yield* withCheckpointLock(
          metadataPath,
          Effect.gen(function* () {
            const store = yield* readCheckpointStore(metadataPath);
            let changed = false;
            for (const checkpointRef of input.checkpointRefs) {
              if (Object.hasOwn(store, checkpointRef)) {
                delete store[checkpointRef];
                changed = true;
              }
            }
            if (changed) {
              yield* writeCheckpointStore(operation, input.cwd, metadataPath, store);
            }
          }),
        );
      },
    ),
  };

  return VcsDriver.VcsDriver.of({
    execute,
    checkpoints,
    detectRepository,
    isInsideWorkTree,
    listWorkspaceFiles,
    listRemotes,
    filterIgnoredPaths,
    initRepository,
  });
});

export const layerVcs = Layer.effect(VcsDriver.VcsDriver, makeVcsDriver);
