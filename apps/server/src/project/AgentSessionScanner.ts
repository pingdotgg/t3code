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
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type AgentSessionProjectCandidate,
  type AgentSessionScanResult,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";

import * as ServerConfig from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { expandHomePath } from "../pathExpansion.ts";
import * as ServerSettings from "../serverSettings.ts";

/** Chunk size for transcript reads; stop as soon as session metadata names its cwd. */
const TRANSCRIPT_PREFIX_BYTES = 32 * 1024;
/** Prevent malformed transcripts from turning project discovery into a full file scan. */
const MAX_TRANSCRIPT_SCAN_BYTES = 1024 * 1024;

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
const RECENT_THREAD_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_IMPORTED_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const MAX_IMPORTED_MESSAGES = 200;

const TranscriptContentBlock = Schema.Struct({
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
});

const TranscriptMessage = Schema.Struct({
  role: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Union([Schema.String, Schema.Array(TranscriptContentBlock)])),
  model: Schema.optional(Schema.String),
});

const TranscriptRecord = Schema.Struct({
  type: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  aiTitle: Schema.optional(Schema.String),
  isSidechain: Schema.optional(Schema.Boolean),
  isMeta: Schema.optional(Schema.Boolean),
  isCompactSummary: Schema.optional(Schema.Boolean),
  message: Schema.optional(TranscriptMessage),
  payload: Schema.optional(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      session_id: Schema.optional(Schema.String),
      type: Schema.optional(Schema.String),
      role: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
      model: Schema.optional(Schema.String),
      content: Schema.optional(Schema.Array(TranscriptContentBlock)),
    }),
  ),
});

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);
const decodeTranscriptRecord = Schema.decodeUnknownOption(Schema.fromJsonString(TranscriptRecord));

export interface AgentSessionThreadMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

export interface AgentSessionThread {
  readonly source: AgentSessionSource;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerSessionId: string;
  readonly title: string;
  readonly model: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: ReadonlyArray<AgentSessionThreadMessage>;
}

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
    readonly recentThreads: (
      workspaceRoot: string,
    ) => Stream.Stream<AgentSessionThread, AgentSessionScanError>;
  }
>()("t3/project/AgentSessionScanner") {}

type AgentSessionSource = AgentSessionProjectCandidate["sources"][number];

/** A single directory's worth of evidence from one source. */
interface RawCandidate {
  readonly cwd: string;
  readonly source: AgentSessionSource;
  readonly providerInstanceIds: Array<ProviderInstanceId>;
  readonly threadCount: number;
  readonly lastActiveAtMs: number | null;
  readonly transcripts: ReadonlyArray<{
    readonly filePath: string;
    readonly mtimeMs: number | null;
  }>;
}

function extractText(
  content: string | ReadonlyArray<typeof TranscriptContentBlock.Type> | undefined,
): string {
  if (typeof content === "string") return content.trim();
  if (content === undefined) return "";
  return content
    .filter(
      (block) =>
        block.type === "text" || block.type === "input_text" || block.type === "output_text",
    )
    .map((block) => block.text?.trim() ?? "")
    .filter((text) => text.length > 0)
    .join("\n");
}

function normalizeTimestamp(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : fallback;
}

const LEADING_CODEX_CONTEXT =
  /^\s*(?:<environment_context>[\s\S]*?<\/environment_context>|<user_instructions>[\s\S]*?<\/user_instructions>|# AGENTS\.md instructions for[^\r\n]*\s*<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>)\s*/u;

/** Codex records leading workspace context as user input even though it is not conversation text. */
function visibleCodexUserText(value: string): string {
  let visible = value;
  while (LEADING_CODEX_CONTEXT.test(visible)) {
    visible = visible.replace(LEADING_CODEX_CONTEXT, "");
  }
  return visible.replace(/^\s*## My request for Codex:\s*/u, "").trim();
}

/** Keep visible user and assistant text while ignoring tools, reasoning, and malformed records. */
export function parseAgentSessionTranscript(input: {
  readonly contents: string;
  readonly source: AgentSessionSource;
  readonly providerInstanceId: ProviderInstanceId;
  readonly fallbackSessionId: string;
  readonly lastActiveAtMs: number;
}): AgentSessionThread | null {
  const fallbackTimestamp = DateTime.formatIso(DateTime.makeUnsafe(input.lastActiveAtMs));
  // Claude filenames are session IDs. Codex rollout filenames include extra
  // timestamp text, so only transcript metadata can provide a resumable ID.
  let providerSessionId = input.source === "codex" ? "" : input.fallbackSessionId;
  let title: string | null = null;
  let model: string | null = null;
  let hasCodexSessionId = false;
  const messages: Array<AgentSessionThreadMessage & { readonly codexResponseUser: boolean }> = [];
  let firstUserMessage:
    | (AgentSessionThreadMessage & { readonly codexResponseUser: boolean })
    | undefined;

  const retainMessage = (
    message: AgentSessionThreadMessage & { readonly codexResponseUser: boolean },
  ) => {
    if (firstUserMessage === undefined && message.role === "user") {
      firstUserMessage = message;
    }
    messages.push(message);
    if (messages.length > MAX_IMPORTED_MESSAGES) messages.shift();
  };

  const hasMatchingCodexEventInTurn = (text: string) => {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message?.role === "assistant") return false;
      if (message?.role === "user" && !message.codexResponseUser && message.text === text) {
        return true;
      }
    }
    return false;
  };

  for (const line of input.contents.split("\n")) {
    const decoded = decodeTranscriptRecord(line);
    if (Option.isNone(decoded)) continue;
    const record = decoded.value;

    if (input.source === "claudeAgent") {
      if (
        record.isSidechain === true ||
        record.isMeta === true ||
        record.isCompactSummary === true
      ) {
        continue;
      }
      if (record.sessionId?.trim()) providerSessionId = record.sessionId.trim();
      if (record.aiTitle?.trim()) title = record.aiTitle.trim();
      const messageModel = record.message?.model?.trim();
      // Claude uses this sentinel for local error responses. It is not a
      // model ID that can be selected when the imported session resumes.
      if (messageModel && messageModel !== "<synthetic>") model = messageModel;
      if (record.type !== "user" && record.type !== "assistant") {
        continue;
      }

      const text = extractText(record.message?.content);
      if (text.length === 0) continue;
      retainMessage({
        role: record.type,
        text,
        createdAt: normalizeTimestamp(record.timestamp, fallbackTimestamp),
        codexResponseUser: false,
      });
      continue;
    }

    if (record.type === "session_meta") {
      const sessionId = record.payload?.id?.trim() || record.payload?.session_id?.trim();
      if (!hasCodexSessionId && sessionId) {
        providerSessionId = sessionId;
        hasCodexSessionId = true;
      }
      continue;
    }
    if (record.type === "turn_context" && record.payload?.model?.trim()) {
      model = record.payload.model.trim();
      continue;
    }
    if (record.type === "event_msg" && record.payload?.type === "user_message") {
      const text = visibleCodexUserText(record.payload.message ?? "");
      if (text.length === 0) continue;
      // Codex can write the same prompt as both a response item and an event.
      // Remove only the matching response copy so mixed-format logs keep every
      // distinct user message.
      for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (message?.role === "assistant") break;
        if (message?.codexResponseUser === true && message.text === text) {
          messages.splice(index, 1);
          break;
        }
      }
      retainMessage({
        role: "user",
        text,
        createdAt: normalizeTimestamp(record.timestamp, fallbackTimestamp),
        codexResponseUser: false,
      });
      continue;
    }
    if (
      record.type !== "response_item" ||
      record.payload?.type !== "message" ||
      (record.payload.role !== "user" && record.payload.role !== "assistant")
    ) {
      continue;
    }

    const extractedText = extractText(record.payload.content);
    const text =
      record.payload.role === "user" ? visibleCodexUserText(extractedText) : extractedText;
    if (text.length === 0) continue;
    if (record.payload.role === "user" && hasMatchingCodexEventInTurn(text)) {
      continue;
    }
    retainMessage({
      role: record.payload.role,
      text,
      createdAt: normalizeTimestamp(record.timestamp, fallbackTimestamp),
      codexResponseUser: record.payload.role === "user",
    });
  }

  const visibleMessages = messages.map(
    ({ codexResponseUser: _codexResponseUser, ...message }) => message,
  );
  if (providerSessionId.trim().length === 0 || firstUserMessage === undefined) return null;
  const { codexResponseUser: _codexResponseUser, ...visibleFirstUserMessage } = firstUserMessage;
  const retainedMessages = visibleMessages.some((message) => message.role === "user")
    ? visibleMessages
    : [visibleFirstUserMessage, ...visibleMessages.slice(-(MAX_IMPORTED_MESSAGES - 1))];

  return {
    source: input.source,
    providerInstanceId: input.providerInstanceId,
    providerSessionId,
    title:
      title ??
      visibleFirstUserMessage.text.split("\n")[0]?.slice(0, 100).trim() ??
      "Imported thread",
    model,
    createdAt: retainedMessages[0]?.createdAt ?? fallbackTimestamp,
    updatedAt: fallbackTimestamp,
    messages: retainedMessages,
  };
}

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
  const baseDir = path.resolve(serverConfig.baseDir);
  const worktreesDir = path.resolve(serverConfig.worktreesDir);
  // Windows filesystems are case-insensitive, so path prefix checks there
  // must case fold.
  const foldWorktreeCase = (yield* HostProcessPlatform) === "win32";
  const hostEnvironment = yield* HostProcessEnvironment;
  const excludedProjectRoots = new Set(
    [NodeOS.homedir(), NodeOS.tmpdir()].map((directory) =>
      normalizeProjectPathForComparison(path.resolve(directory)),
    ),
  );

  const isExcludedProjectPath = (candidatePath: string) =>
    excludedProjectRoots.has(normalizeProjectPathForComparison(candidatePath)) ||
    normalizeForWorktreeMatch(candidatePath, foldWorktreeCase).startsWith(
      normalizeForWorktreeMatch(baseDir, foldWorktreeCase),
    ) ||
    isT3ManagedWorktree(candidatePath, worktreesDir, foldWorktreeCase);

  const listDirectory = (directory: string) =>
    fileSystem.readDirectory(directory).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

  const statOption = (target: string) =>
    fileSystem.stat(target).pipe(Effect.map(Option.some), Effect.orElseSucceed(Option.none));

  // A large history snapshot can precede session metadata. Read bounded
  // chunks until a complete record names its cwd or the safety budget ends.
  const readCwd = Effect.fn("AgentSessionScanner.readCwd")(function* (filePath: string) {
    return yield* Effect.scoped(
      fileSystem.open(filePath, { flag: "r" }).pipe(
        Effect.flatMap((file) =>
          Effect.gen(function* () {
            const decoder = new TextDecoder();
            let remaining = "";
            let bytesRead = 0;

            while (bytesRead < MAX_TRANSCRIPT_SCAN_BYTES) {
              const next = yield* file.readAlloc(
                Math.min(TRANSCRIPT_PREFIX_BYTES, MAX_TRANSCRIPT_SCAN_BYTES - bytesRead),
              );
              if (Option.isNone(next)) {
                return extractCwd(remaining.trim());
              }

              bytesRead += next.value.byteLength;
              remaining += decoder.decode(next.value, { stream: true });
              const lines = remaining.split("\n");
              remaining = lines.pop() ?? "";

              for (const line of lines) {
                const cwd = extractCwd(line.trim());
                if (cwd !== null) return cwd;
              }
            }

            return null;
          }),
        ),
      ),
    ).pipe(Effect.orElseSucceed(() => null));
  });

  /**
   * Read one stable transcript snapshot. The guard byte detects a file that
   * grew after stat without reading past the hard per-file limit.
   */
  const readTranscript = Effect.fn("AgentSessionScanner.readTranscript")(function* (
    filePath: string,
    expectedSize: bigint,
  ) {
    if (expectedSize > BigInt(MAX_IMPORTED_TRANSCRIPT_BYTES)) return null;
    const expectedBytes = Number(expectedSize);

    return yield* Effect.scoped(
      fileSystem.open(filePath, { flag: "r" }).pipe(
        Effect.flatMap((file) =>
          Effect.gen(function* () {
            const decoder = new TextDecoder();
            let contents = "";
            let bytesRead = 0;

            while (bytesRead <= expectedBytes) {
              const next = yield* file.readAlloc(
                Math.min(TRANSCRIPT_PREFIX_BYTES, expectedBytes + 1 - bytesRead),
              );
              if (Option.isNone(next)) {
                return contents + decoder.decode();
              }

              bytesRead += next.value.byteLength;
              if (bytesRead > expectedBytes) return null;
              contents += decoder.decode(next.value, { stream: true });
            }

            return null;
          }),
        ),
      ),
    ).pipe(Effect.orElseSucceed(() => null));
  });

  /**
   * Resolve the Claude config directory the CLI would use, matching the
   * precedence the spawned CLI sees: the instance's `homePath` (exported as
   * `CLAUDE_CONFIG_DIR`), then a `CLAUDE_CONFIG_DIR` already in the
   * environment, then `~/.claude`.
   */
  const resolveClaudeConfigDir = (homePath: string, environmentHome?: string): string => {
    const configured = homePath.trim();
    if (configured.length > 0) {
      return path.resolve(expandHomePath(configured));
    }
    const fromEnvironment = environmentHome?.trim() ?? "";
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
  const scanClaude = Effect.fn("AgentSessionScanner.scanClaude")(function* (
    homePath: string,
    providerInstanceId: ProviderInstanceId,
  ) {
    const projectsDir = path.join(homePath, "projects");
    const projectDirectories = yield* listDirectory(projectsDir);
    let statBudget = MAX_STATS_PER_SOURCE;
    const transcripts: Array<{ filePath: string; mtimeMs: number }> = [];

    for (const projectDirectory of projectDirectories) {
      if (statBudget <= 0) break;
      const directory = path.join(projectsDir, projectDirectory);
      const directoryTranscripts = (yield* listDirectory(directory))
        .filter((entry) => entry.endsWith(".jsonl"))
        .map((entry) => path.join(directory, entry));
      if (directoryTranscripts.length === 0) continue;

      const statted = directoryTranscripts.slice(0, statBudget);
      statBudget -= statted.length;
      for (const filePath of statted) {
        const stats = yield* statOption(filePath);
        if (Option.isNone(stats) || Option.isNone(stats.value.mtime)) continue;
        transcripts.push({ filePath, mtimeMs: stats.value.mtime.value.getTime() });
      }
    }

    // Apply the read budget across every project, not separately by directory.
    transcripts.sort((left, right) => right.mtimeMs - left.mtimeMs);
    transcripts.splice(MAX_TRANSCRIPTS_PER_SOURCE);

    const byCwd = new Map<
      string,
      {
        threadCount: number;
        lastActiveAtMs: number;
        transcripts: Array<{ filePath: string; mtimeMs: number }>;
      }
    >();
    for (const entry of transcripts) {
      const cwd = yield* readCwd(entry.filePath);
      if (cwd === null) continue;
      const existing = byCwd.get(cwd);
      if (existing) {
        existing.threadCount += 1;
        existing.lastActiveAtMs = Math.max(existing.lastActiveAtMs, entry.mtimeMs);
        existing.transcripts.push(entry);
      } else {
        byCwd.set(cwd, {
          threadCount: 1,
          lastActiveAtMs: entry.mtimeMs,
          transcripts: [entry],
        });
      }
    }

    return Array.from(
      byCwd,
      ([cwd, group]): RawCandidate => ({
        cwd,
        source: "claudeAgent",
        providerInstanceIds: [providerInstanceId],
        threadCount: group.threadCount,
        lastActiveAtMs: group.lastActiveAtMs,
        transcripts: group.transcripts,
      }),
    );
  });

  /**
   * Codex writes `sessions/YYYY/MM/DD/rollout-*.jsonl`. Always scan the shared
   * home: in auth-overlay mode the effective home only symlinks to it.
   */
  const scanCodex = Effect.fn("AgentSessionScanner.scanCodex")(function* (
    homePath: string,
    providerInstanceId: ProviderInstanceId,
  ) {
    const sessionsDir = path.join(homePath, "sessions");

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

    const byCwd = new Map<string, Array<{ filePath: string; mtimeMs: number | null }>>();
    for (const rollout of rollouts) {
      const cwd = yield* readCwd(rollout);
      if (cwd === null) continue;
      const stats = yield* statOption(rollout);
      const mtimeMs =
        Option.isSome(stats) && Option.isSome(stats.value.mtime)
          ? stats.value.mtime.value.getTime()
          : null;
      const transcript = { filePath: rollout, mtimeMs };
      const existing = byCwd.get(cwd);
      if (existing) {
        existing.push(transcript);
      } else {
        byCwd.set(cwd, [transcript]);
      }
    }

    const candidates: Array<RawCandidate> = [];
    for (const [cwd, transcripts] of byCwd) {
      candidates.push({
        cwd,
        source: "codex",
        providerInstanceIds: [providerInstanceId],
        threadCount: transcripts.length,
        lastActiveAtMs: transcripts.reduce<number | null>(
          (latest, transcript) =>
            transcript.mtimeMs === null
              ? latest
              : latest === null
                ? transcript.mtimeMs
                : Math.max(latest, transcript.mtimeMs),
          null,
        ),
        transcripts,
      });
    }
    return candidates;
  });

  const collectCandidates = Effect.fn("AgentSessionScanner.collectCandidates")(function* () {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-settings", cause })),
    );

    const raw: Array<RawCandidate> = [];
    const scannedHomes = new Map<string, ReadonlyArray<RawCandidate>>();

    for (const source of ["claudeAgent", "codex"] as const) {
      const instances: Array<{
        readonly instanceId: ProviderInstanceId;
        readonly config: ProviderInstanceConfig;
      }> = Object.entries(settings.providerInstances)
        .filter(([, instance]) => instance.driver === source)
        .map(([instanceId, config]) => ({
          instanceId: ProviderInstanceId.make(instanceId),
          config,
        }));
      if (!Object.hasOwn(settings.providerInstances, source)) {
        instances.push({
          instanceId: ProviderInstanceId.make(source),
          config: {
            driver: ProviderDriverKind.make(source),
            config: settings.providers[source],
          },
        });
      }

      for (const { instanceId, config: instance } of instances) {
        const homeVariable = source === "claudeAgent" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
        const environmentHome =
          instance.environment?.findLast((variable) => variable.name === homeVariable)?.value ??
          hostEnvironment[homeVariable];

        let homePath: string;
        if (source === "claudeAgent") {
          const config = decodeClaudeSettings(instance.config ?? {});
          if (Option.isNone(config)) continue;
          homePath = resolveClaudeConfigDir(config.value.homePath, environmentHome);
        } else {
          const config = decodeCodexSettings(instance.config ?? {});
          if (Option.isNone(config)) continue;
          const codexSettings =
            config.value.homePath.trim().length === 0 &&
            config.value.shadowHomePath.trim().length === 0 &&
            environmentHome?.trim()
              ? { ...config.value, homePath: environmentHome }
              : config.value;
          const layout = yield* resolveCodexHomeLayout(codexSettings).pipe(
            Effect.provideService(Path.Path, path),
          );
          homePath = layout.sharedHomePath;
        }

        const realHomePath = yield* fileSystem
          .realPath(homePath)
          .pipe(Effect.orElseSucceed(() => homePath));
        const homeKey = `${source}\0${normalizeProjectPathForComparison(realHomePath)}`;
        const existingCandidates = scannedHomes.get(homeKey);
        if (existingCandidates !== undefined) {
          for (const candidate of existingCandidates) {
            if (!candidate.providerInstanceIds.includes(instanceId)) {
              candidate.providerInstanceIds.push(instanceId);
            }
          }
          continue;
        }
        const candidates = yield* source === "claudeAgent"
          ? scanClaude(homePath, instanceId)
          : scanCodex(homePath, instanceId);
        scannedHomes.set(homeKey, candidates);
        raw.push(...candidates);
      }
    }

    return raw;
  });

  let cachedCandidates: ReadonlyArray<RawCandidate> | null = null;

  const scan: AgentSessionScanner["Service"]["scan"] = Effect.gen(function* () {
    const raw = yield* collectCandidates();
    cachedCandidates = raw;

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
      const expanded = expandHomePath(candidate.cwd.trim());
      if (!path.isAbsolute(expanded)) continue;
      const resolved = path.resolve(expanded);
      if (isExcludedProjectPath(resolved)) continue;
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
        if (isExcludedProjectPath(key)) {
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
    const importedProjectsByRoot = new Map(
      shellSnapshot.projects.map(
        (project) =>
          [normalizeProjectPathForComparison(project.workspaceRoot), project.id] as const,
      ),
    );

    const candidates: Array<AgentSessionProjectCandidate> = [];
    for (const [key, entry] of merged.entries()) {
      // Projects may have been created under either the recorded spelling or
      // the resolved realpath (e.g. a symlinked home) — check both.
      const projectId =
        importedProjectsByRoot.get(normalizeProjectPathForComparison(entry.path)) ??
        importedProjectsByRoot.get(normalizeProjectPathForComparison(key));
      candidates.push({
        path: entry.path,
        title: path.basename(entry.path) || entry.path,
        ...(projectId === undefined ? {} : { projectId }),
        sources: entry.sources,
        threadCount: entry.threadCount,
        lastActiveAt:
          entry.lastActiveAtMs === null
            ? null
            : DateTime.formatIso(DateTime.makeUnsafe(entry.lastActiveAtMs)),
        alreadyImported: projectId !== undefined,
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

  const prepareRecentThreads = Effect.fn("AgentSessionScanner.prepareRecentThreads")(function* (
    workspaceRoot: string,
  ) {
    const root = path.resolve(expandHomePath(workspaceRoot));
    const realRoot = yield* fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => root));
    if (isExcludedProjectPath(root) || isExcludedProjectPath(realRoot)) return Stream.empty;
    const normalizedRoot = normalizeProjectPathForComparison(realRoot);
    const cutoffMs = DateTime.toEpochMillis(yield* DateTime.now) - RECENT_THREAD_WINDOW_MS;

    const candidates = cachedCandidates ?? (yield* collectCandidates());
    cachedCandidates = candidates;

    const eligibleTranscripts: Array<{
      readonly candidate: RawCandidate;
      readonly transcript: RawCandidate["transcripts"][number] & { readonly mtimeMs: number };
    }> = [];
    for (const candidate of candidates) {
      const expanded = expandHomePath(candidate.cwd.trim());
      if (!path.isAbsolute(expanded)) continue;
      const resolved = path.resolve(expanded);
      const realCandidate = yield* fileSystem
        .realPath(resolved)
        .pipe(Effect.orElseSucceed(() => resolved));
      if (normalizeProjectPathForComparison(realCandidate) !== normalizedRoot) continue;

      for (const transcript of candidate.transcripts) {
        if (transcript.mtimeMs === null || transcript.mtimeMs < cutoffMs) continue;
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

    const importedSessions = new Set<string>();
    return Stream.fromIteratorSucceed(eligibleTranscripts.values(), 1).pipe(
      Stream.mapEffect(({ candidate, transcript }) =>
        Effect.gen(function* () {
          const stats = yield* statOption(transcript.filePath);
          if (Option.isNone(stats)) return [];
          const contents = yield* readTranscript(transcript.filePath, stats.value.size);
          if (contents === null) return [];

          const primaryInstanceId = candidate.providerInstanceIds[0];
          if (primaryInstanceId === undefined) return [];
          const parsedThread = parseAgentSessionTranscript({
            contents,
            source: candidate.source,
            providerInstanceId: primaryInstanceId,
            fallbackSessionId: path.basename(transcript.filePath, ".jsonl"),
            lastActiveAtMs: transcript.mtimeMs,
          });
          if (parsedThread === null) return [];

          const threads: Array<AgentSessionThread> = [];
          for (const providerInstanceId of candidate.providerInstanceIds) {
            const thread =
              providerInstanceId === primaryInstanceId
                ? parsedThread
                : { ...parsedThread, providerInstanceId };
            const sessionKey = `${thread.providerInstanceId}\0${thread.providerSessionId}`;
            if (importedSessions.has(sessionKey)) continue;
            importedSessions.add(sessionKey);
            threads.push(thread);
          }
          return threads;
        }),
      ),
      Stream.flatMap(Stream.fromIterable),
    );
  });

  const recentThreads: AgentSessionScanner["Service"]["recentThreads"] = (workspaceRoot) =>
    Stream.unwrap(prepareRecentThreads(workspaceRoot));

  return AgentSessionScanner.of({ scan, recentThreads });
});

export const layer = Layer.effect(AgentSessionScanner, make);
