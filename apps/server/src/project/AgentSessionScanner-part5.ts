
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
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AgentSessionScanner, MAX_IMPORTED_TRANSCRIPT_BYTES, MAX_IMPORT_BYTES, MAX_IMPORT_TRANSCRIPTS, RECENT_THREAD_WINDOW_MS, parseAgentSessionRecords, sameTranscriptIdentity, transcriptIdentity } from "./AgentSessionScanner.ts";
import type { AgentSessionRecentThread, AgentSessionSource, RawCandidate } from "./AgentSessionScanner.ts";

import { isBareGitConfig, parseOriginUrlFromGitConfig } from "@t3tools/shared/git";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";

import * as ServerConfig from "../config.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

import type { makeAgentSessionScannerStage2 } from "./AgentSessionScanner-part4.ts";

type State = Effect.Success<ReturnType<typeof makeAgentSessionScannerStage2>>;

export const makeAgentSessionScannerFlows = Effect.fn("makeAgentSessionScannerFlows")(function* (state: State) {
  const {
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
    collectCandidates,
    cachedCandidates,
  } = state;
  const scan: AgentSessionScanner["Service"]["scan"] = Effect.gen(function* () {
    const { candidates: raw, truncated } = yield* collectCandidates();
    cachedCandidates.value = raw;

    const merged = new Map<
      string,
      {
        path: string;
        sources: Array<AgentSessionSource>;
        threadCount: number;
        lastActiveAtMs: number | null;
        git: AgentSessionProjectGit | null;
      }
    >();
    // Resolve every candidate directory first so one batch reads all git identities.
    const directories = new Map<string, Option.Option<FileSystem.File.Info>>();
    for (const candidate of raw) {
      const expanded = expandHomePath(candidate.cwd.trim(), homeDir);
      if (!path.isAbsolute(expanded)) continue;
      const resolved = path.resolve(expanded);
      if (directories.has(resolved) || isExcludedProjectPath(resolved)) continue;
      const stats = yield* statOption(resolved);
      if (Option.isNone(stats) || stats.value.type !== "Directory") {
        directories.set(resolved, Option.none());
        continue;
      }
      const realPath = yield* fileSystem
        .realPath(resolved)
        .pipe(Effect.orElseSucceed(() => resolved));
      // Symlinks can disguise excluded worktree paths; re-check their targets.
      directories.set(resolved, isExcludedProjectPath(realPath) ? Option.none() : stats);
    }
    const directoryGitIdentities = yield* readGitIdentities(
      Array.from(directories).flatMap(([directory, stats]) =>
        Option.isSome(stats) ? [directory] : [],
      ),
    );

    const directoryKeys = new Map<string, string>();
    const gitIdentities = new Map<string, AgentSessionProjectGit | null>();

    for (const candidate of raw) {
      const expanded = expandHomePath(candidate.cwd.trim(), homeDir);
      if (!path.isAbsolute(expanded)) continue;
      const resolved = path.resolve(expanded);
      const stats = directories.get(resolved);
      if (stats === undefined || Option.isNone(stats)) continue;
      let key = directoryKeys.get(resolved);
      if (key === undefined) {
        const gitIdentity = directoryGitIdentities.get(resolved);
        if (gitIdentity === undefined || gitIdentity._tag === "Worktree") {
          key = "";
        } else {
          key = yield* directoryIdentity(resolved, stats.value);
          gitIdentities.set(key, gitIdentity._tag === "Repository" ? gitIdentity.git : null);
        }
        directoryKeys.set(resolved, key);
      }
      if (key === "") continue;

      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, {
          path: resolved,
          sources: [candidate.source],
          threadCount: candidate.threadCount,
          lastActiveAtMs: candidate.lastActiveAtMs,
          git: gitIdentities.get(key) ?? null,
        });
        continue;
      }
      if (!existing.sources.includes(candidate.source)) {
        existing.sources.push(candidate.source);
      }
      existing.threadCount += candidate.threadCount;
      existing.lastActiveAtMs =
        existing.lastActiveAtMs === null || candidate.lastActiveAtMs === null
          ? (existing.lastActiveAtMs ?? candidate.lastActiveAtMs)
          : Math.max(existing.lastActiveAtMs, candidate.lastActiveAtMs);
    }

    // Resolve persisted roots too; transcripts may use different symlinks to the same directory.
    const importedProjects = yield* projectStore
      .listShells()
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    const importedProjectsByRoot = new Map<string, (typeof importedProjects)[number]>();
    for (const project of importedProjects) {
      const projectRoot = path.resolve(expandHomePath(project.workspaceRoot, homeDir));
      importedProjectsByRoot.set(normalizeProjectPathForComparison(projectRoot), project);
      importedProjectsByRoot.set(yield* directoryIdentity(projectRoot), project);
    }

    const candidates: Array<AgentSessionProjectCandidate> = [];
    for (const [key, entry] of merged.entries()) {
      const importedProject =
        importedProjectsByRoot.get(normalizeProjectPathForComparison(entry.path)) ??
        importedProjectsByRoot.get(key);
      const candidatePath = importedProject?.workspaceRoot ?? entry.path;
      candidates.push({
        path: candidatePath,
        title: path.basename(candidatePath) || candidatePath,
        ...(importedProject === undefined ? {} : { projectId: importedProject.id }),
        sources: entry.sources,
        threadCount: entry.threadCount,
        lastActiveAt:
          entry.lastActiveAtMs === null
            ? null
            : DateTime.formatIso(DateTime.makeUnsafe(entry.lastActiveAtMs)),
        alreadyImported: importedProject !== undefined,
        git: entry.git,
      });
    }

    candidates.sort((left, right) => {
      if (left.lastActiveAt === right.lastActiveAt) return left.path.localeCompare(right.path);
      if (left.lastActiveAt === null) return 1;
      if (right.lastActiveAt === null) return -1;
      return right.lastActiveAt.localeCompare(left.lastActiveAt);
    });

    return {
      candidates,
      scannedAt: DateTime.formatIso(yield* DateTime.now),
      ...(truncated ? { truncated: true } : {}),
    };
  });

  const prepareRecentThreads = Effect.fn("AgentSessionScanner.prepareRecentThreads")(function* (
    workspaceRoot: string,
    completedSources: ReadonlyArray<AgentSessionImportSource>,
  ) {
    const root = path.resolve(expandHomePath(workspaceRoot, homeDir));
    const realRoot = yield* fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => root));
    if (isExcludedProjectPath(root) || isExcludedProjectPath(realRoot)) return Stream.empty;
    const rootIdentity = yield* directoryIdentity(root);
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const cutoffMs = nowMs - RECENT_THREAD_WINDOW_MS;

    const candidates = cachedCandidates.value ?? (yield* collectCandidates()).candidates;
    cachedCandidates.value = candidates;

    const eligibleTranscripts: Array<{
      readonly candidate: RawCandidate;
      readonly transcript: RawCandidate["transcripts"][number] & { readonly mtimeMs: number };
    }> = [];
    for (const candidate of candidates) {
      const expanded = expandHomePath(candidate.cwd.trim(), homeDir);
      if (!path.isAbsolute(expanded)) continue;
      const resolved = path.resolve(expanded);
      if ((yield* directoryIdentity(resolved)) !== rootIdentity) continue;

      for (const transcript of candidate.transcripts) {
        if (
          transcript.mtimeMs === null ||
          transcript.mtimeMs < cutoffMs ||
          transcript.mtimeMs > nowMs
        ) {
          continue;
        }
        eligibleTranscripts.push({
          candidate,
          transcript: { ...transcript, mtimeMs: transcript.mtimeMs },
        });
      }
    }

    eligibleTranscripts.sort((left, right) => {
      if (left.transcript.mtimeMs !== right.transcript.mtimeMs) {
        return right.transcript.mtimeMs - left.transcript.mtimeMs;
      }
      return left.transcript.filePath.localeCompare(right.transcript.filePath);
    });

    const completedByFile = Map.groupBy(
      completedSources,
      (source) => `${source.providerInstanceId}\0${source.filePath}`,
    );
    const importedSessions = new Set<string>();
    const codexThreadNamesByHome = new Map<string, ReadonlyMap<string, string>>();
    let bytesRemaining = MAX_IMPORT_BYTES;
    let transcriptsRemaining = MAX_IMPORT_TRANSCRIPTS;
    return Stream.fromIteratorSucceed(eligibleTranscripts.values(), 1).pipe(
      Stream.mapEffect(({ candidate, transcript }) =>
        Effect.gen(function* () {
          const completed = completedByFile.get(
            `${candidate.providerInstanceId}\0${transcript.filePath}`,
          );
          if (completed === undefined && (transcriptsRemaining === 0 || bytesRemaining === 0)) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }
          const stats = yield* statOption(transcript.filePath);
          if (Option.isNone(stats) || stats.value.type !== "File") {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }
          const identity = transcriptIdentity(transcript.filePath, stats.value);
          const completedSource = completed?.find(
            (source) =>
              source.provider === candidate.source && sameTranscriptIdentity(source, identity),
          );
          if (completedSource !== undefined) {
            const sessionKey = `${completedSource.providerInstanceId}\0${completedSource.providerSessionId}`;
            if (importedSessions.has(sessionKey)) return Option.none<AgentSessionRecentThread>();
            importedSessions.add(sessionKey);
            return Option.some<AgentSessionRecentThread>({
              _tag: "AlreadyImported",
              source: completedSource,
            });
          }
          if (
            transcriptsRemaining === 0 ||
            identity.size > MAX_IMPORTED_TRANSCRIPT_BYTES ||
            identity.size > bytesRemaining
          ) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }
          transcriptsRemaining -= 1;
          bytesRemaining -= identity.size;
          const snapshot = yield* readTranscript(transcript.filePath, identity, candidate.source);
          if (snapshot === null) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }

          if (Option.isNone(snapshot.cwd)) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }
          const expandedCwd = expandHomePath(snapshot.cwd.value.trim(), homeDir);
          if (
            !path.isAbsolute(expandedCwd) ||
            (yield* directoryIdentity(path.resolve(expandedCwd))) !== rootIdentity
          ) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }

          const parsedThread = parseAgentSessionRecords(
            {
              source: candidate.source,
              providerInstanceId: candidate.providerInstanceId,
              fallbackSessionId: path.basename(transcript.filePath, ".jsonl"),
              lastActiveAtMs: transcript.mtimeMs,
            },
            snapshot.records,
            snapshot.claudeFields,
          );
          if (parsedThread === null) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }
          let savedTitle: string | undefined;
          if (candidate.source === "codex") {
            const names =
              codexThreadNamesByHome.get(candidate.homePath) ??
              (yield* readCodexThreadNames(candidate.homePath));
            codexThreadNamesByHome.set(candidate.homePath, names);
            savedTitle = names.get(parsedThread.providerSessionId);
          }

          const source: AgentSessionImportSource = {
            ...identity,
            provider: parsedThread.source,
            providerInstanceId: parsedThread.providerInstanceId,
            providerSessionId: parsedThread.providerSessionId,
          };
          const sessionKey = `${parsedThread.providerInstanceId}\0${parsedThread.providerSessionId}`;
          if (importedSessions.has(sessionKey)) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Duplicate", source });
          }
          importedSessions.add(sessionKey);
          return Option.some<AgentSessionRecentThread>({
            _tag: "Importable",
            thread:
              savedTitle === undefined ? parsedThread : { ...parsedThread, title: savedTitle },
            source,
          });
        }).pipe(importReadLock.withPermits(1)),
      ),
      Stream.map(Option.toArray),
      Stream.flattenIterable,
    );
  });

  const recentThreads: AgentSessionScanner["Service"]["recentThreads"] = (
    workspaceRoot,
    completedSources = [],
  ) => Stream.unwrap(prepareRecentThreads(workspaceRoot, completedSources));

  return { scan, recentThreads };
});
