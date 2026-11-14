import * as NodeOS from "node:os";
import { AgentSessionScanner, BLOCKED_GIT_FILE_RETRY_MS, GIT_FILE_READ_CONCURRENCY, GIT_FILE_READ_DEADLINE, MAX_BLOCKED_GIT_FILE_PATHS, MAX_CODEX_SESSION_INDEX_BYTES, MAX_GIT_FILE_BYTES, MAX_IMPORTED_TRANSCRIPT_BYTES, MAX_IMPORT_HISTORY_BYTES, MAX_IMPORT_RECORDS, MAX_METADATA_RECORDS_PER_TRANSCRIPT, MAX_TRANSCRIPT_SCAN_BYTES, METADATA_READ_BYTES, TRANSCRIPT_PREFIX_BYTES, decodePiEntryLinks, decodeTranscriptValue, emptyClaudeFields, extractCwd, extractDecodedCwd, foldClaudeFields, isPiConversationRecord, isT3ManagedWorktree, normalizeForWorktreeMatch, parseCodexThreadNames, sameTranscriptIdentity, selectTranscriptPath, shouldRetainDecodedRecord, transcriptIdentity } from "./AgentSessionScanner.ts";
import type { AgentSessionSource, DecodedTranscriptRecord, MetadataReadBudget, RawCandidate, TranscriptCandidate } from "./AgentSessionScanner.ts";

import {
  AgentSessionScanError,
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type AgentSessionImportSource,
  type AgentSessionProjectCandidate,
  type AgentSessionProjectGit,
  type AgentSessionScanResult,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import { isBareGitConfig, parseOriginUrlFromGitConfig } from "@t3tools/shared/git";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { repositoryPathFromRemoteUrl } from "@t3tools/source-control-core/server/SourceControlProvider";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as ServerSettings from "../serverSettings.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import {
  createTranscriptJsonReader,
  createTranscriptJsonSelector,
  TranscriptJsonLimitError,
} from "./AgentSessionJson.ts";

export const makeAgentSessionScannerState = Effect.fn("makeAgentSessionScannerState")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  // Concurrent client imports must not hold multiple selected-history budgets.
  const importReadLock = yield* Semaphore.make(1);
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const baseDir = path.resolve(serverConfig.baseDir);
  const worktreesDir = path.resolve(serverConfig.worktreesDir);
  const isWindows = (yield* HostProcess.Platform) === "win32";
  const foldWorktreeCase = isWindows;
  const hostEnvironment = yield* HostProcess.Environment;
  const homeDir = yield* HostProcess.HomeDirectory;
  // `/private/tmp` is what macOS reports for sessions started in `/tmp`.
  const excludedProjectRoots = new Set(
    [homeDir, NodeOS.tmpdir(), "/tmp", "/private/tmp"].map((directory) =>
      normalizeProjectPathForComparison(path.resolve(directory)),
    ),
  );
  const excludedProjectAncestors = [
    path.join(homeDir, "Downloads"),
    path.join(homeDir, "Documents", "Codex"),
  ];

  const isExcludedProjectPath = (candidatePath: string) =>
    excludedProjectRoots.has(normalizeProjectPathForComparison(candidatePath)) ||
    excludedProjectAncestors.some((ancestor) =>
      normalizeForWorktreeMatch(candidatePath, foldWorktreeCase).startsWith(
        normalizeForWorktreeMatch(ancestor, foldWorktreeCase),
      ),
    ) ||
    normalizeForWorktreeMatch(candidatePath, foldWorktreeCase).startsWith(
      normalizeForWorktreeMatch(baseDir, foldWorktreeCase),
    ) ||
    isT3ManagedWorktree(candidatePath, worktreesDir, foldWorktreeCase);

  const listDirectory = (directory: string) =>
    fileSystem.readDirectory(directory).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

  const statOption = (target: string) =>
    fileSystem.stat(target).pipe(Effect.asSome, Effect.orElseSucceed(Option.none));

  const directoryIdentity = Effect.fn("AgentSessionScanner.directoryIdentity")(function* (
    target: string,
    knownStats?: FileSystem.File.Info,
  ) {
    const resolved = path.resolve(target);
    const stats = knownStats === undefined ? yield* statOption(resolved) : Option.some(knownStats);
    if (Option.isSome(stats) && Option.isSome(stats.value.ino) && stats.value.ino.value > 0n) {
      return `inode:${stats.value.dev}:${stats.value.ino.value}`;
    }
    const realPath = yield* fileSystem
      .realPath(resolved)
      .pipe(Effect.orElseSucceed(() => resolved));
    return `path:${normalizeProjectPathForComparison(realPath)}`;
  });

  // Paths whose own read outlived the deadline, mapped to when they may be read
  // again. Without this every later scan would wait out the deadline again for
  // each phase that touches them.
  const blockedGitFilePaths = new Map<string, number>();

  /** Reads small files without the libuv pool; "" when missing, unreadable or blocked. */
  const readGitFiles = Effect.fn("AgentSessionScanner.readGitFiles")(function* (
    filePaths: ReadonlyArray<string>,
  ) {
    const unique = Array.from(new Set(filePaths));
    const now = yield* Clock.currentTimeMillis;
    const contents = yield* Effect.forEach(
      unique,
      (filePath) => {
        // No privacy prompts or FIFOs to block open() here.
        if (isWindows) {
          return fileSystem.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
        }
        if ((blockedGitFilePaths.get(filePath) ?? 0) > now) return Effect.succeed("");
        blockedGitFilePaths.delete(filePath);
        return processRunner
          .run({
            command: "cat",
            args: ["--", filePath],
            timeout: GIT_FILE_READ_DEADLINE,
            timeoutBehavior: "timedOutResult",
            maxOutputBytes: MAX_GIT_FILE_BYTES,
            outputMode: "truncate",
          })
          .pipe(
            Effect.map((result) => {
              if (result.timedOut) {
                if (blockedGitFilePaths.size >= MAX_BLOCKED_GIT_FILE_PATHS) {
                  blockedGitFilePaths.delete(blockedGitFilePaths.keys().next().value!);
                }
                blockedGitFilePaths.set(filePath, now + BLOCKED_GIT_FILE_RETRY_MS);
              }
              return result.code === 0 ? result.stdout : "";
            }),
            Effect.orElseSucceed(() => ""),
          );
      },
      { concurrency: isWindows ? 1 : GIT_FILE_READ_CONCURRENCY },
    );
    return new Map(unique.map((filePath, index) => [filePath, contents[index]!]));
  });

  /** Reads every directory's git identity in three phases of concurrent reads. */
  const readGitIdentities = Effect.fn("AgentSessionScanner.readGitIdentities")(function* (
    directories: ReadonlyArray<string>,
  ) {
    type GitIdentity =
      | { readonly _tag: "Repository"; readonly git: AgentSessionProjectGit | null }
      | { readonly _tag: "Worktree" }
      | { readonly _tag: "NotGit" };
    const identities = new Map<string, GitIdentity>();
    const repositories: Array<{ directory: string; gitDir: string; linkedWorktree: boolean }> = [];
    const pointers: Array<{ directory: string; gitPath: string }> = [];
    for (const directory of directories) {
      const gitPath = path.join(directory, ".git");
      const gitStats = yield* statOption(gitPath);
      if (Option.isNone(gitStats)) identities.set(directory, { _tag: "NotGit" });
      else if (gitStats.value.type === "Directory") {
        repositories.push({ directory, gitDir: gitPath, linkedWorktree: false });
      } else pointers.push({ directory, gitPath });
    }

    const pointerTexts = yield* readGitFiles(pointers.map(({ gitPath }) => gitPath));
    const linkedWorktrees: Array<{ directory: string; gitDir: string }> = [];
    for (const { directory, gitPath } of pointers) {
      const target = /^gitdir:\s*(.+)$/m.exec(pointerTexts.get(gitPath) ?? "")?.[1]?.trim();
      if (target === undefined || target.length === 0) {
        identities.set(directory, { _tag: "NotGit" });
        continue;
      }
      const gitDir = path.resolve(directory, target);
      if (/[\\/]worktrees[\\/][^\\/]+[\\/]?$/.test(gitDir)) {
        linkedWorktrees.push({ directory, gitDir });
      } else repositories.push({ directory, gitDir, linkedWorktree: false });
    }

    const commonDirTexts = yield* readGitFiles(
      linkedWorktrees.map(({ gitDir }) => path.join(gitDir, "commondir")),
    );
    for (const { directory, gitDir } of linkedWorktrees) {
      const commonDir = (commonDirTexts.get(path.join(gitDir, "commondir")) ?? "").trim();
      if (commonDir.length === 0) identities.set(directory, { _tag: "Worktree" });
      else
        repositories.push({
          directory,
          gitDir: path.resolve(gitDir, commonDir),
          linkedWorktree: true,
        });
    }

    const configTexts = yield* readGitFiles(
      repositories.map(({ gitDir }) => path.join(gitDir, "config")),
    );
    for (const { directory, gitDir, linkedWorktree } of repositories) {
      const configText = configTexts.get(path.join(gitDir, "config")) ?? "";
      // Bare repositories have no main checkout, so offer their linked worktrees independently.
      if (linkedWorktree && !isBareGitConfig(configText)) {
        identities.set(directory, { _tag: "Worktree" });
        continue;
      }
      const originUrl = parseOriginUrlFromGitConfig(configText);
      identities.set(directory, {
        _tag: "Repository",
        git: {
          remoteKey:
            originUrl === null ? null : sourceControlDefinitions.repositoryKeyFromRemote(originUrl),
          repository: repositoryPathFromRemoteUrl(originUrl),
        },
      });
    }
    return identities;
  });

  const readCwd = Effect.fn("AgentSessionScanner.readCwd")(function* (
    source: AgentSessionSource,
    transcript: TranscriptCandidate,
    budget: MetadataReadBudget,
  ) {
    if (transcript.size === 0) return null;
    if (
      budget.bytesRemaining === 0 ||
      budget.operationsRemaining < 2 ||
      budget.recordsRemaining === 0
    ) {
      budget.truncated = true;
      return null;
    }
    budget.operationsRemaining -= 1;
    return yield* Effect.scoped(
      fileSystem.open(transcript.filePath, { flag: "r" }).pipe(
        Effect.flatMap((file) =>
          Effect.gen(function* () {
            const decoder = new TextDecoder();
            let remaining = "";
            let bytesRead = 0;
            let recordsRead = 0;
            const maxBytes = Math.min(MAX_TRANSCRIPT_SCAN_BYTES, transcript.size);
            const reserveRecord = () => {
              if (
                recordsRead === MAX_METADATA_RECORDS_PER_TRANSCRIPT ||
                budget.recordsRemaining === 0
              ) {
                budget.truncated = true;
                return false;
              }
              recordsRead += 1;
              budget.recordsRemaining -= 1;
              return true;
            };
            const readLastRecord = () => {
              const record = remaining + decoder.decode();
              return record.length === 0 || !reserveRecord()
                ? null
                : extractCwd(record.trim(), source);
            };

            while (bytesRead < maxBytes) {
              if (budget.bytesRemaining === 0 || budget.operationsRemaining === 0) {
                budget.truncated = true;
                return null;
              }
              const readSize = Math.min(
                METADATA_READ_BYTES,
                maxBytes - bytesRead,
                budget.bytesRemaining,
              );
              budget.operationsRemaining -= 1;
              budget.bytesRemaining -= readSize;
              const next = yield* file.readAlloc(readSize);
              if (Option.isNone(next)) {
                return readLastRecord();
              }

              bytesRead += next.value.byteLength;
              remaining += decoder.decode(next.value, { stream: true });
              const lines = remaining.split("\n");
              remaining = lines.pop() ?? "";

              for (const line of lines) {
                if (!reserveRecord()) return null;
                const cwd = extractCwd(line.trim(), source);
                if (cwd !== null) return cwd;
              }
            }

            if (bytesRead < transcript.size) {
              budget.truncated = true;
              return null;
            }
            return readLastRecord();
          }),
        ),
      ),
    ).pipe(Effect.orElseSucceed(() => null));
  });

  const readTranscript = Effect.fn("AgentSessionScanner.readTranscript")(function* (
    filePath: string,
    expected: ReturnType<typeof transcriptIdentity>,
    source: AgentSessionSource,
  ) {
    if (expected.size > MAX_IMPORTED_TRANSCRIPT_BYTES) return null;

    return yield* Effect.scoped(
      fileSystem.open(filePath, { flag: "r" }).pipe(
        Effect.flatMap((file) =>
          Effect.gen(function* () {
            if (!sameTranscriptIdentity(expected, transcriptIdentity(filePath, yield* file.stat))) {
              return null;
            }
            const records: Array<DecodedTranscriptRecord> = [];
            let cwd = Option.none<string>();
            let claudeFields = emptyClaudeFields;
            let historyBytes = 0;
            let recordBytes = 0;
            let recordCount = 0;
            let bytesRead = 0;
            const reserve = (bytes: number) => {
              recordBytes += bytes;
              if (historyBytes + recordBytes > MAX_IMPORT_HISTORY_BYTES) {
                throw new TranscriptJsonLimitError(
                  "Transcript selected history exceeds the 32 MiB memory budget",
                );
              }
            };
            let reader = createTranscriptJsonReader(reserve, selectTranscriptPath);
            let decoder = new TextDecoder();
            let recordStarted = false;

            const finishRecord = () => {
              reader.write(decoder.decode());
              recordCount += 1;
              if (recordCount > MAX_IMPORT_RECORDS) return false;
              const value = reader.finish();
              const decoded = decodeTranscriptValue(value);
              if (Option.isNone(decoded) && source === "pi") {
                // Pi accepts messages this schema rejects, such as null content; keep their tree links.
                records.push(...Option.toArray(decodePiEntryLinks(value)));
              } else if (Option.isSome(decoded)) {
                if (Option.isNone(cwd)) cwd = Option.fromNullOr(extractDecodedCwd(decoded.value));
                if (source === "claudeAgent") {
                  claudeFields = foldClaudeFields(claudeFields, decoded.value);
                }
                if (shouldRetainDecodedRecord(source, decoded.value)) {
                  if (
                    source === "pi" &&
                    decoded.value.type === "message" &&
                    !isPiConversationRecord(decoded.value)
                  ) {
                    // Tool output can dwarf the conversation; keep only the tree links.
                    const { message: _message, ...links } = decoded.value;
                    records.push(links);
                  } else {
                    records.push(decoded.value);
                    historyBytes += recordBytes;
                  }
                }
              }
              recordBytes = 0;
              reader = createTranscriptJsonReader(reserve, selectTranscriptPath);
              decoder = new TextDecoder();
              recordStarted = false;
              return true;
            };

            while (bytesRead < expected.size) {
              const next = yield* file.readAlloc(
                Math.min(TRANSCRIPT_PREFIX_BYTES, expected.size - bytesRead),
              );
              if (Option.isNone(next)) {
                return null;
              }

              bytesRead += next.value.byteLength;
              const withinBudget = yield* Effect.try(() => {
                let start = 0;
                while (start < next.value.byteLength) {
                  const newline = next.value.indexOf(10, start);
                  const end = newline === -1 ? next.value.byteLength : newline;
                  recordStarted = true;
                  reader.write(decoder.decode(next.value.subarray(start, end), { stream: true }));
                  if (newline === -1) break;
                  if (!finishRecord()) return false;
                  start = newline + 1;
                }
                return true;
              });
              if (!withinBudget) return null;
            }

            if (recordStarted && !(yield* Effect.try(finishRecord))) return null;
            return sameTranscriptIdentity(expected, transcriptIdentity(filePath, yield* file.stat))
              ? { records, cwd, claudeFields }
              : null;
          }),
        ),
      ),
    ).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not read imported transcript", { filePath, cause }).pipe(
          Effect.as(null),
        ),
      ),
    );
  });

  const readCodexThreadNames = Effect.fn("AgentSessionScanner.readCodexThreadNames")(function* (
    homePath: string,
  ) {
    const indexPath = path.join(homePath, "session_index.jsonl");
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(indexPath, { flag: "r" });
        const size = Number((yield* file.stat).size);
        const start = Math.max(0, size - MAX_CODEX_SESSION_INDEX_BYTES);
        yield* file.seek(BigInt(start), "start");
        const bytes = yield* file.readAlloc(size - start);
        const contents = Option.match(bytes, {
          onNone: () => "",
          onSome: (value) => new TextDecoder().decode(value),
        });
        // A tail read can start mid-record.
        return parseCodexThreadNames(
          start > 0 ? contents.slice(contents.indexOf("\n") + 1) : contents,
        );
      }),
    ).pipe(Effect.orElseSucceed((): ReadonlyMap<string, string> => new Map()));
  });

  const resolveClaudeConfigDir = (homePath: string, environmentHome?: string): string => {
    const configured = homePath.trim();
    if (configured.length > 0) {
      return path.resolve(expandHomePath(configured, homeDir));
    }
    const fromEnvironment = environmentHome?.trim() ?? "";
    if (fromEnvironment.length > 0) {
      return path.resolve(expandHomePath(fromEnvironment, homeDir));
    }
    return path.join(homeDir, ".claude");
  };

  const discoverClaudeTranscripts = Effect.fn("AgentSessionScanner.discoverClaudeTranscripts")(
    function* (homePath: string, providerInstanceId: ProviderInstanceId, operationBudget: number) {
      const projectsDir = path.join(homePath, "projects");
      let operationsRemaining = operationBudget;
      let truncated = false;
      const readDirectory = (directory: string) => {
        if (operationsRemaining <= 0) {
          truncated = true;
          return Effect.succeed<ReadonlyArray<string>>([]);
        }
        operationsRemaining -= 1;
        return listDirectory(directory);
      };
      const projectDirectories = yield* readDirectory(projectsDir);
      const transcripts: Array<TranscriptCandidate> = [];

      for (const projectDirectory of projectDirectories) {
        if (operationsRemaining <= 0) {
          truncated = true;
          break;
        }
        const directory = path.join(projectsDir, projectDirectory);
        const directoryTranscripts = (yield* readDirectory(directory))
          .filter((entry) => entry.endsWith(".jsonl"))
          .map((entry) => path.join(directory, entry));

        for (const filePath of directoryTranscripts) {
          if (operationsRemaining <= 0) {
            truncated = true;
            break;
          }
          operationsRemaining -= 1;
          const stats = yield* statOption(filePath);
          if (
            Option.isNone(stats) ||
            stats.value.type !== "File" ||
            Option.isNone(stats.value.mtime)
          ) {
            continue;
          }
          transcripts.push({
            filePath,
            mtimeMs: stats.value.mtime.value.getTime(),
            providerInstanceId,
            homePath,
            size: Number(stats.value.size),
          });
        }
      }
      return { transcripts, truncated };
    },
  );

  const discoverCodexTranscripts = Effect.fn("AgentSessionScanner.discoverCodexTranscripts")(
    function* (homePath: string, providerInstanceId: ProviderInstanceId, operationBudget: number) {
      const sessionsDir = path.join(homePath, "sessions");

      const transcripts: Array<TranscriptCandidate> = [];
      let operationsRemaining = operationBudget;
      let truncated = false;
      const readDirectory = (directory: string) => {
        if (operationsRemaining <= 0) {
          truncated = true;
          return Effect.succeed<ReadonlyArray<string>>([]);
        }
        operationsRemaining -= 1;
        return listDirectory(directory);
      };
      for (const year of (yield* readDirectory(sessionsDir)).toSorted().toReversed()) {
        if (operationsRemaining <= 0) {
          truncated = true;
          break;
        }
        for (const month of (yield* readDirectory(path.join(sessionsDir, year)))
          .toSorted()
          .toReversed()) {
          if (operationsRemaining <= 0) {
            truncated = true;
            break;
          }
          for (const day of (yield* readDirectory(path.join(sessionsDir, year, month)))
            .toSorted()
            .toReversed()) {
            if (operationsRemaining <= 0) {
              truncated = true;
              break;
            }
            const directory = path.join(sessionsDir, year, month, day);
            for (const entry of (yield* readDirectory(directory)).toSorted().toReversed()) {
              if (!entry.startsWith("rollout-") || !entry.endsWith(".jsonl")) continue;
              if (operationsRemaining <= 0) {
                truncated = true;
                break;
              }
              const filePath = path.join(directory, entry);
              operationsRemaining -= 1;
              const stats = yield* statOption(filePath);
              if (
                Option.isSome(stats) &&
                stats.value.type === "File" &&
                Option.isSome(stats.value.mtime)
              ) {
                transcripts.push({
                  filePath,
                  mtimeMs: stats.value.mtime.value.getTime(),
                  providerInstanceId,
                  homePath,
                  size: Number(stats.value.size),
                });
              }
            }
          }
        }
      }
      return { transcripts, truncated };
    },
  );

  // Pi nests sessions in one directory per cwd, but a custom session directory holds them flat.
  const discoverPiTranscripts = Effect.fn("AgentSessionScanner.discoverPiTranscripts")(function* (
    sessionsDir: string,
    providerInstanceId: ProviderInstanceId,
    operationBudget: number,
  ) {
    let operationsRemaining = operationBudget;
    let truncated = false;
    const readDirectory = (directory: string) => {
      if (operationsRemaining <= 0) {
        truncated = true;
        return Effect.succeed<ReadonlyArray<string>>([]);
      }
      operationsRemaining -= 1;
      return listDirectory(directory);
    };
    const transcripts: Array<TranscriptCandidate> = [];
    for (const entry of yield* readDirectory(sessionsDir)) {
      if (operationsRemaining <= 0) {
        truncated = true;
        break;
      }
      const entryPath = path.join(sessionsDir, entry);
      const filePaths = entry.endsWith(".jsonl")
        ? [entryPath]
        : (yield* readDirectory(entryPath))
            .filter((nested) => nested.endsWith(".jsonl"))
            .map((nested) => path.join(entryPath, nested));

      for (const filePath of filePaths) {
        if (operationsRemaining <= 0) {
          truncated = true;
          break;
        }
        operationsRemaining -= 1;
        const stats = yield* statOption(filePath);
        if (
          Option.isSome(stats) &&
          stats.value.type === "File" &&
          Option.isSome(stats.value.mtime)
        ) {
          transcripts.push({
            filePath,
            mtimeMs: stats.value.mtime.value.getTime(),
            providerInstanceId,
            homePath: sessionsDir,
            size: Number(stats.value.size),
          });
        }
      }
    }
    return { transcripts, truncated };
  });

  const groupTranscriptsByCwd = Effect.fn("AgentSessionScanner.groupTranscriptsByCwd")(function* (
    source: AgentSessionSource,
    transcripts: ReadonlyArray<TranscriptCandidate>,
    budget: MetadataReadBudget,
  ) {
    const byOwnerAndCwd = new Map<
      string,
      {
        cwd: string;
        providerInstanceId: ProviderInstanceId;
        homePath: string;
        lastActiveAtMs: number;
        transcripts: Array<{ filePath: string; mtimeMs: number }>;
      }
    >();

    for (const transcript of transcripts) {
      const cwd = yield* readCwd(source, transcript, budget);
      if (cwd === null || cwd === false) continue;
      const key = `${transcript.providerInstanceId}\0${cwd}`;
      const existing = byOwnerAndCwd.get(key);
      if (existing) {
        existing.lastActiveAtMs = Math.max(existing.lastActiveAtMs, transcript.mtimeMs);
        existing.transcripts.push(transcript);
      } else {
        byOwnerAndCwd.set(key, {
          cwd,
          providerInstanceId: transcript.providerInstanceId,
          homePath: transcript.homePath,
          lastActiveAtMs: transcript.mtimeMs,
          transcripts: [transcript],
        });
      }
    }

    return Array.from(byOwnerAndCwd.values(), (group): RawCandidate => ({
      cwd: group.cwd,
      source,
      providerInstanceId: group.providerInstanceId,
      homePath: group.homePath,
      threadCount: group.transcripts.length,
      lastActiveAtMs: group.lastActiveAtMs,
      transcripts: group.transcripts,
    }));
  });

  return {
    fileSystem,
    processRunner,
    importReadLock,
    path,
    serverConfig,
    serverSettings,
    projectStore,
    baseDir,
    worktreesDir,
    isWindows,
    foldWorktreeCase,
    hostEnvironment,
    homeDir,
    excludedProjectRoots,
    excludedProjectAncestors,
    isExcludedProjectPath,
    listDirectory,
    statOption,
    directoryIdentity,
    blockedGitFilePaths,
    readGitFiles,
    readGitIdentities,
    readCwd,
    readTranscript,
    readCodexThreadNames,
    resolveClaudeConfigDir,
    discoverClaudeTranscripts,
    discoverCodexTranscripts,
    discoverPiTranscripts,
    groupTranscriptsByCwd,
  };
});
