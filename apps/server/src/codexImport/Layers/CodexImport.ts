import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CommandId,
  CodexImportError,
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  MessageId,
  type CodexImportConcreteSessionKind,
  type CodexImportImportSessionsInput,
  type CodexImportImportSessionsResult,
  type CodexImportListSessionsInput,
  type CodexImportPeekSessionInput,
  type CodexImportPeekSessionResult,
  type CodexImportSessionSummary,
  type ModelSelection,
  type OrchestrationProjectShell,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";

import {
  classifyCodexSessionKind,
  parseCodexTranscript,
  type ParsedCodexTranscript,
} from "../parseCodexTranscript.js";
import { CodexImport, type CodexImportShape } from "../Services/CodexImport.js";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.js";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.js";

const DEFAULT_RECENT_DAYS = 30;
const DEFAULT_RECENT_LIMIT = 50;
const DEFAULT_PEEK_MESSAGE_COUNT = 10;
const TITLE_MAX_CHARS = 80;
const IMPORT_ACTIVITY_KIND = "codex-import.imported";
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CODEX_INSTANCE_ID = ProviderInstanceId.make("codex");

interface DiscoveredCodexRollout {
  readonly filePath: string;
  readonly sessionId: string;
  readonly mtimeMs: number;
}

interface ImportedSessionRef {
  readonly threadId: ThreadId;
  readonly importedAt: string;
}

function defaultCodexHome(explicit: string | undefined): string {
  return explicit ?? path.join(os.homedir(), ".codex");
}

function deriveSessionId(filename: string): string {
  const base = filename.replace(/^rollout-/, "").replace(/\.jsonl$/, "");
  return base || filename;
}

async function discoverRollouts(sessionsRoot: string): Promise<DiscoveredCodexRollout[]> {
  let entries: Array<{ readonly fullPath: string; readonly filename: string }> = [];
  try {
    const rawEntries = await fs.readdir(sessionsRoot, { withFileTypes: true, recursive: true });
    entries = rawEntries
      .filter(
        (entry) =>
          entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl"),
      )
      .map((entry) => {
        const parentPath =
          (entry as unknown as { parentPath?: string; path?: string }).parentPath ??
          (entry as unknown as { parentPath?: string; path?: string }).path ??
          sessionsRoot;
        return {
          fullPath: path.join(parentPath, entry.name),
          filename: entry.name,
        };
      });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }

  const withStats: DiscoveredCodexRollout[] = [];
  for (const { fullPath, filename } of entries) {
    try {
      const stat = await fs.stat(fullPath);
      withStats.push({
        filePath: fullPath,
        sessionId: deriveSessionId(filename),
        mtimeMs: stat.mtimeMs,
      });
    } catch {
      // Skip files we can't stat (permissions, symlink loops, etc.).
    }
  }
  return withStats;
}

async function loadTranscript(
  filePath: string,
): Promise<{ readonly parsed: ParsedCodexTranscript } | { readonly error: string }> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = parseCodexTranscript(raw);
    return { parsed };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
}

function firstUserMessageText(parsed: ParsedCodexTranscript): string | null {
  const first = parsed.messages.find((message) => message.role === "user");
  return first ? first.text : null;
}

function lastMessageText(parsed: ParsedCodexTranscript, role: "user" | "assistant"): string | null {
  for (let index = parsed.messages.length - 1; index >= 0; index -= 1) {
    const message = parsed.messages[index];
    if (message && message.role === role) return message.text;
  }
  return null;
}

function truncateForTitle(input: string): string {
  const normalized = input.trim().replace(/\s+/g, " ");
  if (normalized.length <= TITLE_MAX_CHARS) return normalized;
  return `${normalized.slice(0, TITLE_MAX_CHARS - 1)}…`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function readImportedSessionId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const value = (payload as { readonly sessionId?: unknown }).sessionId;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function buildImportedSessionMap(
  threads: ReadonlyArray<{
    id: ThreadId;
    updatedAt: string;
    activities: ReadonlyArray<{ kind: string; payload: unknown; createdAt: string }>;
  }>,
): ReadonlyMap<string, ImportedSessionRef> {
  const imported = new Map<string, ImportedSessionRef>();
  const sortedThreads = threads.toSorted(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id),
  );
  for (const thread of sortedThreads) {
    const sortedActivities = thread.activities.toSorted((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );
    for (const activity of sortedActivities) {
      if (activity.kind !== IMPORT_ACTIVITY_KIND) {
        continue;
      }
      const sessionId = readImportedSessionId(activity.payload);
      if (!sessionId || imported.has(sessionId)) {
        continue;
      }
      imported.set(sessionId, {
        threadId: thread.id,
        importedAt: activity.createdAt,
      });
    }
  }
  return imported;
}

function resolveImportModelSelection(
  project: OrchestrationProjectShell,
  parsed: ParsedCodexTranscript,
): ModelSelection {
  if (project.defaultModelSelection) {
    return project.defaultModelSelection;
  }
  if (parsed.model && parsed.model.trim().length > 0) {
    return {
      instanceId: CODEX_INSTANCE_ID,
      model: parsed.model.trim(),
    };
  }
  return {
    instanceId: CODEX_INSTANCE_ID,
    model: DEFAULT_MODEL_BY_PROVIDER[CODEX_DRIVER] ?? "gpt-5.4",
  };
}

function buildSummary(
  rollout: DiscoveredCodexRollout,
  parsed: ParsedCodexTranscript,
  importedSessions: ReadonlyMap<string, ImportedSessionRef> = new Map(),
): CodexImportSessionSummary {
  const firstMessage = firstUserMessageText(parsed);
  const title = firstMessage ? truncateForTitle(firstMessage) : rollout.sessionId;
  const kind: CodexImportConcreteSessionKind =
    classifyCodexSessionKind({ source: null, messages: parsed.messages }) ?? "direct";
  const importedRef = importedSessions.get(rollout.sessionId);
  const earliestMs =
    parsed.messages.length > 0
      ? Math.min(
          ...parsed.messages
            .map((message) => Date.parse(message.createdAt))
            .filter(Number.isFinite),
        )
      : rollout.mtimeMs;
  const latestMs =
    parsed.messages.length > 0
      ? Math.max(
          ...parsed.messages
            .map((message) => Date.parse(message.updatedAt))
            .filter(Number.isFinite),
        )
      : rollout.mtimeMs;

  return {
    sessionId: rollout.sessionId,
    title,
    cwd: null,
    createdAt: Number.isFinite(earliestMs) ? iso(earliestMs) : iso(rollout.mtimeMs),
    updatedAt: Number.isFinite(latestMs) ? iso(latestMs) : iso(rollout.mtimeMs),
    model: parsed.model ?? null,
    kind,
    transcriptAvailable: true,
    transcriptError: null,
    alreadyImported: importedRef !== undefined,
    importedThreadId: importedRef?.threadId ?? null,
    lastUserMessage: lastMessageText(parsed, "user"),
    lastAssistantMessage: lastMessageText(parsed, "assistant"),
  };
}

const makeCodexImport = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const loadImportedSessions = () =>
    projectionSnapshotQuery.getSnapshot().pipe(
      Effect.map((snapshot) => buildImportedSessionMap(snapshot.threads)),
      Effect.mapError(
        (cause) =>
          new CodexImportError({
            message: `Failed to read imported-session state: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
      ),
    );

  const loadTargetProject = (targetProjectId: CodexImportImportSessionsInput["targetProjectId"]) =>
    projectionSnapshotQuery.getProjectShellById(targetProjectId).pipe(
      Effect.mapError(
        (cause) =>
          new CodexImportError({
            message: `Failed to read target project ${targetProjectId}: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
      ),
      Effect.flatMap((projectOption) =>
        Option.isSome(projectOption)
          ? Effect.succeed(projectOption.value)
          : Effect.fail(
              new CodexImportError({
                message: `Target project not found: ${targetProjectId}`,
              }),
            ),
      ),
    );

  const listSessions: CodexImportShape["listSessions"] = (input: CodexImportListSessionsInput) =>
    Effect.gen(function* () {
      const codexHome = defaultCodexHome(input.homePath);
      const sessionsRoot = path.join(codexHome, "sessions");
      const importedSessions = yield* loadImportedSessions();
      const rollouts = yield* Effect.tryPromise({
        try: () => discoverRollouts(sessionsRoot),
        catch: (cause) =>
          new CodexImportError({
            message: `Failed to scan Codex sessions at ${sessionsRoot}: ${String(cause)}`,
          }),
      });
      const days = input.days ?? DEFAULT_RECENT_DAYS;
      const limit = input.limit ?? DEFAULT_RECENT_LIMIT;
      const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
      const recent = rollouts
        .filter((rollout) => rollout.mtimeMs >= cutoffMs)
        .toSorted((left, right) => right.mtimeMs - left.mtimeMs)
        .slice(0, limit * 2);

      const summaries: CodexImportSessionSummary[] = [];
      for (const rollout of recent) {
        const loaded = yield* Effect.promise(() => loadTranscript(rollout.filePath));
        if ("error" in loaded) continue;
        const summary = buildSummary(rollout, loaded.parsed, importedSessions);
        if (input.kind !== "all" && summary.kind !== input.kind) continue;
        if (input.query) {
          const needle = input.query.toLowerCase();
          const haystack =
            `${summary.title} ${summary.lastUserMessage ?? ""} ${summary.lastAssistantMessage ?? ""}`.toLowerCase();
          if (!haystack.includes(needle)) continue;
        }
        summaries.push(summary);
        if (summaries.length >= limit) break;
      }
      return summaries;
    });

  const peekSession: CodexImportShape["peekSession"] = (input: CodexImportPeekSessionInput) =>
    Effect.gen(function* () {
      const codexHome = defaultCodexHome(input.homePath);
      const sessionsRoot = path.join(codexHome, "sessions");
      const importedSessions = yield* loadImportedSessions();
      const rollouts = yield* Effect.tryPromise({
        try: () => discoverRollouts(sessionsRoot),
        catch: (cause) =>
          new CodexImportError({ message: `Failed to scan Codex sessions: ${String(cause)}` }),
      });
      const match = rollouts.find((rollout) => rollout.sessionId === input.sessionId);
      if (!match) {
        return yield* new CodexImportError({
          message: `Codex session not found: ${input.sessionId}`,
        });
      }
      const loaded = yield* Effect.promise(() => loadTranscript(match.filePath));
      if ("error" in loaded) {
        return yield* new CodexImportError({
          message: `Failed to read ${match.filePath}: ${loaded.error}`,
        });
      }
      const parsed = loaded.parsed;
      const messageCount = input.messageCount ?? DEFAULT_PEEK_MESSAGE_COUNT;
      const lastMessages = parsed.messages.slice(-messageCount);
      const summary = buildSummary(match, parsed, importedSessions);
      const result: CodexImportPeekSessionResult = {
        sessionId: match.sessionId,
        title: summary.title,
        cwd: null,
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
        model: parsed.model ?? null,
        runtimeMode: parsed.runtimeMode,
        interactionMode: parsed.interactionMode,
        kind: summary.kind,
        transcriptAvailable: true,
        transcriptError: null,
        alreadyImported: summary.alreadyImported,
        importedThreadId: summary.importedThreadId,
        messages: lastMessages.map((message) => ({
          role: message.role,
          text: message.text,
          createdAt: message.createdAt,
        })),
      };
      return result;
    });

  const importSessions: CodexImportShape["importSessions"] = (
    input: CodexImportImportSessionsInput,
  ) =>
    Effect.gen(function* () {
      const codexHome = defaultCodexHome(input.homePath);
      const sessionsRoot = path.join(codexHome, "sessions");
      const project = yield* loadTargetProject(input.targetProjectId);
      const rollouts = yield* Effect.tryPromise({
        try: () => discoverRollouts(sessionsRoot),
        catch: (cause) =>
          new CodexImportError({
            message: `Failed to scan Codex sessions at ${sessionsRoot}: ${String(cause)}`,
          }),
      });
      const importedSessions = new Map(yield* loadImportedSessions());
      const results: Array<CodexImportImportSessionsResult["results"][number]> = [];

      for (const sessionId of input.sessionIds) {
        const existing = importedSessions.get(sessionId);
        if (existing) {
          results.push({
            sessionId,
            status: "skipped-existing",
            threadId: existing.threadId,
            projectId: input.targetProjectId,
            error: null,
          });
          continue;
        }

        const match = rollouts.find((rollout) => rollout.sessionId === sessionId);
        if (!match) {
          results.push({
            sessionId,
            status: "failed",
            threadId: null,
            projectId: input.targetProjectId,
            error: `Codex session not found: ${sessionId}`,
          });
          continue;
        }

        const loaded = yield* Effect.promise(() => loadTranscript(match.filePath));
        if ("error" in loaded) {
          results.push({
            sessionId,
            status: "failed",
            threadId: null,
            projectId: input.targetProjectId,
            error: `Failed to read ${match.filePath}: ${loaded.error}`,
          });
          continue;
        }

        const parsed = loaded.parsed;
        const summary = buildSummary(match, parsed, importedSessions);
        const nextThreadId = ThreadId.make(crypto.randomUUID());
        const createdAt = summary.createdAt ?? new Date().toISOString();
        const importedAt = new Date().toISOString();
        const modelSelection = resolveImportModelSelection(project, parsed);

        const importResult = yield* Effect.match(
          Effect.gen(function* () {
            yield* orchestrationEngine.dispatch({
              type: "thread.create",
              commandId: CommandId.make(crypto.randomUUID()),
              threadId: nextThreadId,
              projectId: input.targetProjectId,
              title: summary.title,
              modelSelection,
              runtimeMode: parsed.runtimeMode,
              interactionMode: parsed.interactionMode,
              branch: null,
              worktreePath: null,
              createdAt,
            });

            for (const message of parsed.messages) {
              yield* orchestrationEngine.dispatch({
                type: "thread.message.append",
                commandId: CommandId.make(crypto.randomUUID()),
                threadId: nextThreadId,
                message: {
                  messageId: MessageId.make(crypto.randomUUID()),
                  role: message.role,
                  text: message.text,
                },
                createdAt: message.createdAt,
              });
            }

            yield* orchestrationEngine.dispatch({
              type: "thread.activity.append",
              commandId: CommandId.make(crypto.randomUUID()),
              threadId: nextThreadId,
              activity: {
                id: EventId.make(crypto.randomUUID()),
                tone: "info",
                kind: IMPORT_ACTIVITY_KIND,
                summary: `Imported from Codex session ${summary.title}`,
                payload: {
                  sessionId,
                  sourceKind: summary.kind,
                  sourceCreatedAt: summary.createdAt,
                  sourceUpdatedAt: summary.updatedAt,
                  sourceModel: parsed.model,
                  importedAt,
                },
                turnId: null,
                createdAt: importedAt,
              },
              createdAt: importedAt,
            });
          }),
          {
            onFailure: (cause) => ({
              sessionId,
              status: "failed" as const,
              threadId: null,
              projectId: input.targetProjectId,
              error: cause instanceof Error ? cause.message : String(cause),
            }),
            onSuccess: () => ({
              sessionId,
              status: "imported" as const,
              threadId: nextThreadId,
              projectId: input.targetProjectId,
              error: null,
            }),
          },
        );

        results.push(importResult);
        if (importResult.status === "imported" && importResult.threadId) {
          importedSessions.set(sessionId, {
            threadId: importResult.threadId,
            importedAt,
          });
        }
      }

      return { results };
    });

  return {
    listSessions,
    peekSession,
    importSessions,
  } satisfies CodexImportShape;
});

export const CodexImportLive = Layer.effect(CodexImport, makeCodexImport);
