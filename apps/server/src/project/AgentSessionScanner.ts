/**
 * AgentSessionScanner - discovery of projects a user already works on.
 *
 * Claude Code and Codex both keep a per-session transcript on disk, and each
 * transcript records the directory the session ran in. Reading those `cwd`
 * values gives us the set of directories worth offering as projects during
 * onboarding, without asking the user to browse the filesystem.
 *
 * The scan is read-only and best-effort: an unreadable home, a malformed
 * transcript, or a directory that has since been deleted is skipped rather
 * than failing the scan. Project creation stays with the client, which
 * dispatches `project.create` for whichever candidates the user picks.
 *
 * @module project/AgentSessionScanner
 */
import * as NodeOS from "node:os";

import {
  AgentSessionScanError,
  type AgentSessionProjectCandidate,
  type AgentSessionScanResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";

import * as ServerConfig from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { expandHomePath } from "../pathExpansion.ts";
import * as ServerSettings from "../serverSettings.ts";

/**
 * Bytes read from the head of each transcript. Session metadata (including
 * `cwd`) is written in the first record, so reading a prefix keeps the scan
 * cheap even when a transcript is hundreds of megabytes.
 */
const TRANSCRIPT_PREFIX_BYTES = 32 * 1024;

/**
 * Upper bound on transcripts inspected (first line read) per source.
 * Newest-first ordering means the cap drops only stale sessions when a home
 * directory is unusually large.
 */
const MAX_TRANSCRIPTS_PER_SOURCE = 5000;

/**
 * Upper bound on `stat` calls per source. Newest-first ordering needs mtimes
 * before the read cap can be applied, so stats get their own larger budget;
 * once it runs out the scan stops rather than walking a pathological home
 * indefinitely.
 */
const MAX_STATS_PER_SOURCE = MAX_TRANSCRIPTS_PER_SOURCE * 4;

/** Service tag for agent session discovery. */
export class AgentSessionScanner extends Context.Service<
  AgentSessionScanner,
  {
    /**
     * Discover every directory the configured Claude and Codex homes have run
     * a session in. Candidates are returned newest-first; the client decides
     * which ones to import and how far back to look. Fails with the contract
     * error directly — there is no server-local context worth wrapping.
     */
    readonly scan: Effect.Effect<AgentSessionScanResult, AgentSessionScanError>;
  }
>()("t3/project/AgentSessionScanner") {}

type AgentSessionSource = AgentSessionProjectCandidate["sources"][number];

/** A single directory's worth of evidence from one source. */
interface RawCandidate {
  readonly cwd: string;
  readonly source: AgentSessionSource;
  readonly threadCount: number;
  readonly lastActiveAtMs: number | null;
}

const decoder = new TextDecoder();

/**
 * T3 Code runs its own agent sessions inside disposable worktrees. Their
 * transcripts look exactly like user sessions, but re-importing the app's own
 * sandboxes as projects is never right. Matches this server's configured
 * worktrees directory plus the conventional `.t3/worktrees` layout, which
 * also catches sandboxes from other T3 homes on the same machine. Separators
 * are normalized (and, on Windows, case folded) so the prefix match holds
 * there too. Callers check both the recorded spelling and its realpath so a
 * symlink into the worktrees directory cannot bypass the filter.
 */
function normalizeForWorktreeMatch(value: string, caseFold: boolean): string {
  const normalized = `${value.replaceAll("\\", "/")}/`;
  return caseFold ? normalized.toLowerCase() : normalized;
}

function isT3ManagedWorktree(
  candidatePath: string,
  worktreesDir: string,
  caseFold: boolean,
): boolean {
  const normalized = normalizeForWorktreeMatch(candidatePath, caseFold);
  return (
    normalized.startsWith(normalizeForWorktreeMatch(worktreesDir, caseFold)) ||
    normalized.includes("/.t3/worktrees/")
  );
}

/** Extract `cwd` from a session-meta record, tolerating the shapes each CLI writes. */
function extractCwd(line: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  if (typeof record.cwd === "string" && record.cwd.trim().length > 0) {
    return record.cwd;
  }
  // Codex nests session metadata under `payload`.
  const payload = record.payload;
  if (typeof payload === "object" && payload !== null) {
    const nested = (payload as Record<string, unknown>).cwd;
    if (typeof nested === "string" && nested.trim().length > 0) {
      return nested;
    }
  }
  return null;
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const worktreesDir = path.resolve(serverConfig.worktreesDir);
  // Windows filesystems are case-insensitive, so path prefix checks there
  // must case fold.
  const foldWorktreeCase = (yield* HostProcessPlatform) === "win32";
  const hostEnvironment = yield* HostProcessEnvironment;

  const listDirectory = (directory: string) =>
    fileSystem.readDirectory(directory).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

  const statOption = (target: string) =>
    fileSystem.stat(target).pipe(Effect.map(Option.some), Effect.orElseSucceed(Option.none));

  /**
   * Read the head of a transcript and return its complete lines. Returns an
   * empty list when the file is unreadable; a trailing partial line (cut by
   * the prefix cap) is dropped rather than parsed as truncated JSON.
   */
  const readHeadLines = Effect.fn("AgentSessionScanner.readHeadLines")(function* (
    filePath: string,
  ): Effect.fn.Return<ReadonlyArray<string>> {
    const prefix = yield* Effect.scoped(
      fileSystem
        .open(filePath, { flag: "r" })
        .pipe(Effect.flatMap((file) => file.readAlloc(TRANSCRIPT_PREFIX_BYTES))),
    ).pipe(Effect.orElseSucceed(Option.none<Uint8Array>));
    if (Option.isNone(prefix)) return [];

    const text = decoder.decode(prefix.value);
    const lines = text.split("\n");
    // A prefix-capped read may end mid-line; only a file smaller than the cap
    // is guaranteed to have a complete final line.
    if (prefix.value.length >= TRANSCRIPT_PREFIX_BYTES) {
      lines.pop();
    }
    return lines;
  });

  // Transcripts often open with records that carry no cwd (Claude writes
  // file-history snapshots and queue operations first), so scan every
  // complete line in the prefix for the first one that names a directory.
  const readCwd = Effect.fn("AgentSessionScanner.readCwd")(function* (filePath: string) {
    const lines = yield* readHeadLines(filePath);
    for (const line of lines) {
      const cwd = extractCwd(line.trim());
      if (cwd !== null) return cwd;
    }
    return null;
  });

  const latestMtimeMs = Effect.fn("AgentSessionScanner.latestMtimeMs")(function* (
    filePaths: ReadonlyArray<string>,
  ) {
    let latest: number | null = null;
    for (const filePath of filePaths) {
      const stats = yield* statOption(filePath);
      if (Option.isNone(stats)) continue;
      const mtime = stats.value.mtime;
      if (Option.isNone(mtime)) continue;
      const value = mtime.value.getTime();
      if (latest === null || value > latest) {
        latest = value;
      }
    }
    return latest;
  });

  /**
   * Resolve the Claude config directory the CLI would use, matching the
   * precedence the spawned CLI sees: the instance's `homePath` (exported as
   * `CLAUDE_CONFIG_DIR`), then a `CLAUDE_CONFIG_DIR` already in the
   * environment, then `~/.claude`.
   */
  const resolveClaudeConfigDir = (homePath: string): string => {
    const configured = homePath.trim();
    if (configured.length > 0) {
      return path.resolve(expandHomePath(configured));
    }
    const fromEnvironment = hostEnvironment.CLAUDE_CONFIG_DIR?.trim() ?? "";
    if (fromEnvironment.length > 0) {
      return path.resolve(expandHomePath(fromEnvironment));
    }
    return path.join(NodeOS.homedir(), ".claude");
  };

  /**
   * Claude keeps one directory per project under `projects/`, named after a
   * lossy slug of the path. The slug can't be decoded (both `/` and `.` become
   * `-`), so the real path comes from the `cwd` recorded in the newest
   * transcript inside it.
   */
  const scanClaude = Effect.fn("AgentSessionScanner.scanClaude")(function* (homePath: string) {
    const projectsDir = path.join(resolveClaudeConfigDir(homePath), "projects");
    const projectDirectories = yield* listDirectory(projectsDir);
    const candidates: Array<RawCandidate> = [];
    let readBudget = MAX_TRANSCRIPTS_PER_SOURCE;
    let statBudget = MAX_STATS_PER_SOURCE;

    for (const projectDirectory of projectDirectories) {
      if (readBudget <= 0 || statBudget <= 0) break;
      const directory = path.join(projectsDir, projectDirectory);
      const transcripts = (yield* listDirectory(directory))
        .filter((entry) => entry.endsWith(".jsonl"))
        .map((entry) => path.join(directory, entry));
      if (transcripts.length === 0) continue;

      // Stat (bounded), then spend the read budget newest-first, so the cap
      // only ever drops the oldest transcripts.
      const statted = transcripts.slice(0, statBudget);
      statBudget -= statted.length;
      const withMtimes: Array<{ filePath: string; mtimeMs: number }> = [];
      for (const filePath of statted) {
        const stats = yield* statOption(filePath);
        if (Option.isNone(stats) || Option.isNone(stats.value.mtime)) continue;
        withMtimes.push({ filePath, mtimeMs: stats.value.mtime.value.getTime() });
      }
      withMtimes.sort((left, right) => right.mtimeMs - left.mtimeMs);
      withMtimes.splice(readBudget);
      readBudget -= withMtimes.length;

      // The slug is lossy (`/a/b.c` and `/a/b/c` share a directory), so a
      // directory can hold sessions from several distinct paths — group by
      // the recorded cwd like the Codex scan does.
      const byCwd = new Map<string, { threadCount: number; lastActiveAtMs: number }>();
      for (const entry of withMtimes) {
        const cwd = yield* readCwd(entry.filePath);
        if (cwd === null) continue;
        const existing = byCwd.get(cwd);
        if (existing) {
          existing.threadCount += 1;
          existing.lastActiveAtMs = Math.max(existing.lastActiveAtMs, entry.mtimeMs);
        } else {
          byCwd.set(cwd, { threadCount: 1, lastActiveAtMs: entry.mtimeMs });
        }
      }
      for (const [cwd, group] of byCwd) {
        candidates.push({
          cwd,
          source: "claudeAgent",
          threadCount: group.threadCount,
          lastActiveAtMs: group.lastActiveAtMs,
        });
      }
    }

    return candidates;
  });

  /**
   * Codex writes `sessions/YYYY/MM/DD/rollout-*.jsonl`. Always scan the shared
   * home: in auth-overlay mode the effective home only symlinks to it.
   */
  const scanCodex = Effect.fn("AgentSessionScanner.scanCodex")(function* (
    codexSettings: Parameters<typeof resolveCodexHomeLayout>[0],
  ) {
    const layout = yield* resolveCodexHomeLayout(codexSettings).pipe(
      Effect.provideService(Path.Path, path),
    );
    const sessionsDir = path.join(layout.sharedHomePath, "sessions");

    const rollouts: Array<string> = [];
    // Date-partitioned directories sort chronologically, so walking them in
    // reverse keeps the newest sessions when the budget runs out.
    for (const year of (yield* listDirectory(sessionsDir)).toSorted().toReversed()) {
      for (const month of (yield* listDirectory(path.join(sessionsDir, year)))
        .toSorted()
        .toReversed()) {
        for (const day of (yield* listDirectory(path.join(sessionsDir, year, month)))
          .toSorted()
          .toReversed()) {
          const directory = path.join(sessionsDir, year, month, day);
          for (const entry of (yield* listDirectory(directory)).toSorted().toReversed()) {
            if (!entry.startsWith("rollout-") || !entry.endsWith(".jsonl")) continue;
            rollouts.push(path.join(directory, entry));
            if (rollouts.length >= MAX_TRANSCRIPTS_PER_SOURCE) break;
          }
          if (rollouts.length >= MAX_TRANSCRIPTS_PER_SOURCE) break;
        }
        if (rollouts.length >= MAX_TRANSCRIPTS_PER_SOURCE) break;
      }
      if (rollouts.length >= MAX_TRANSCRIPTS_PER_SOURCE) break;
    }

    const byCwd = new Map<string, Array<string>>();
    for (const rollout of rollouts) {
      const cwd = yield* readCwd(rollout);
      if (cwd === null) continue;
      const existing = byCwd.get(cwd);
      if (existing) {
        existing.push(rollout);
      } else {
        byCwd.set(cwd, [rollout]);
      }
    }

    const candidates: Array<RawCandidate> = [];
    for (const [cwd, filePaths] of byCwd) {
      candidates.push({
        cwd,
        source: "codex",
        threadCount: filePaths.length,
        lastActiveAtMs: yield* latestMtimeMs(filePaths),
      });
    }
    return candidates;
  });

  const scan: AgentSessionScanner["Service"]["scan"] = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-settings", cause })),
    );

    const raw = [
      ...(yield* scanClaude(settings.providers.claudeAgent.homePath)),
      ...(yield* scanCodex(settings.providers.codex)),
    ];

    // Merge by resolved path first so both sources agree on a key, then by
    // realpath so a symlinked home and its target collapse into one candidate.
    const merged = new Map<
      string,
      {
        path: string;
        sources: Array<AgentSessionSource>;
        threadCount: number;
        lastActiveAtMs: number | null;
      }
    >();
    const realPathKeys = new Map<string, string>();

    for (const candidate of raw) {
      const resolved = path.resolve(expandHomePath(candidate.cwd.trim()));
      if (isT3ManagedWorktree(resolved, worktreesDir, foldWorktreeCase)) continue;
      let key = realPathKeys.get(resolved);
      if (key === undefined) {
        const stats = yield* statOption(resolved);
        // Directories that no longer exist can't be imported.
        if (Option.isNone(stats) || stats.value.type !== "Directory") {
          realPathKeys.set(resolved, "");
          continue;
        }
        key = yield* fileSystem.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved));
        // A symlink can point into the worktrees directory even when its own
        // spelling doesn't; check again with links resolved.
        if (isT3ManagedWorktree(key, worktreesDir, foldWorktreeCase)) {
          key = "";
        }
        realPathKeys.set(resolved, key);
      }
      if (key === "") continue;

      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, {
          path: resolved,
          sources: [candidate.source],
          threadCount: candidate.threadCount,
          lastActiveAtMs: candidate.lastActiveAtMs,
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

    // One snapshot read, compared with the same normalization the
    // project.create invariant uses, so a root that differs only by case or
    // separators is still recognized as imported.
    const shellSnapshot = yield* projectionSnapshotQuery
      .getShellSnapshot()
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    const importedRoots = new Set(
      shellSnapshot.projects.map((project) =>
        normalizeProjectPathForComparison(project.workspaceRoot),
      ),
    );

    const candidates: Array<AgentSessionProjectCandidate> = [];
    for (const [key, entry] of merged.entries()) {
      // Projects may have been created under either the recorded spelling or
      // the resolved realpath (e.g. a symlinked home) — check both.
      const alreadyImported =
        importedRoots.has(normalizeProjectPathForComparison(entry.path)) ||
        importedRoots.has(normalizeProjectPathForComparison(key));
      candidates.push({
        path: entry.path,
        title: path.basename(entry.path) || entry.path,
        sources: entry.sources,
        threadCount: entry.threadCount,
        lastActiveAt:
          entry.lastActiveAtMs === null
            ? null
            : DateTime.formatIso(DateTime.makeUnsafe(entry.lastActiveAtMs)),
        alreadyImported,
      });
    }

    // Newest first, undated candidates last.
    candidates.sort((left, right) => {
      if (left.lastActiveAt === right.lastActiveAt) return left.path.localeCompare(right.path);
      if (left.lastActiveAt === null) return 1;
      if (right.lastActiveAt === null) return -1;
      return right.lastActiveAt.localeCompare(left.lastActiveAt);
    });

    return {
      candidates,
      scannedAt: DateTime.formatIso(yield* DateTime.now),
    };
  });

  return AgentSessionScanner.of({ scan });
});

export const layer = Layer.effect(AgentSessionScanner, make);
