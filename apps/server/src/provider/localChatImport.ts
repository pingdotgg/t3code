import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";

import {
  CodexSettings,
  CommandId,
  EventId,
  LocalChatImportError,
  type LocalChatImportInput,
  type LocalChatImportPlatform,
  type LocalChatImportResult,
  MessageId,
  OpenCodeSettings,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type ServerSettings,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { expandHomePath } from "../pathExpansion.ts";
import { resolveCodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";
import * as ProviderSessionDirectory from "./Services/ProviderSessionDirectory.ts";

export type ImportedToolItemType =
  | "command_execution"
  | "file_change"
  | "mcp_tool_call"
  | "dynamic_tool_call"
  | "collab_agent_tool_call"
  | "web_search"
  | "image_view";

export interface ImportedChatMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

export interface ImportedChatActivity {
  readonly id: string;
  readonly createdAt: string;
  readonly sequence: number;
  readonly tone: "tool" | "error";
  readonly summary: string;
  readonly payload: {
    readonly itemType: ImportedToolItemType;
    readonly status: "completed" | "failed";
    readonly detail?: string;
    readonly data: Record<string, unknown>;
  };
}

export interface ImportedChatSession {
  readonly id: string;
  readonly title: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly createdAt: string;
  readonly messages: ReadonlyArray<ImportedChatMessage>;
  readonly activities: ReadonlyArray<ImportedChatActivity>;
}

interface ResolvedImportConfig {
  readonly platform: LocalChatImportPlatform;
  readonly instanceId: ProviderInstanceId;
  readonly environment: NodeJS.ProcessEnv;
  readonly config: CodexSettings | OpenCodeSettings;
}

const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);
const decodeOpenCodeSettings = Schema.decodeUnknownEffect(OpenCodeSettings);

function importError(platform: LocalChatImportPlatform, reason: string, cause?: unknown) {
  return new LocalChatImportError({
    platform,
    reason,
    ...(cause === undefined ? {} : { cause }),
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function isoTimestamp(value: unknown, fallback = "1970-01-01T00:00:00.000Z"): string {
  const parsed =
    typeof value === "number" && Number.isFinite(value)
      ? DateTime.make(value < 10_000_000_000 ? value * 1_000 : value)
      : typeof value === "string"
        ? DateTime.make(value)
        : Option.none();
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : fallback;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("\n\n");
  const record = asRecord(value);
  return record
    ? (stringValue(record.text) ?? stringValue(record.content) ?? stringValue(record.output) ?? "")
    : "";
}

function toolItemType(name: string): ImportedToolItemType {
  const normalized = name.toLowerCase();
  if (
    normalized.includes("exec") ||
    normalized.includes("shell") ||
    normalized.includes("terminal") ||
    normalized === "bash" ||
    normalized === "process"
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("patch") ||
    normalized.includes("write") ||
    normalized.includes("edit") ||
    normalized.includes("file_change")
  ) {
    return "file_change";
  }
  if (normalized.includes("web_search") || normalized === "search") return "web_search";
  if (
    normalized.includes("image") ||
    normalized.includes("vision") ||
    normalized.includes("screenshot")
  ) {
    return "image_view";
  }
  if (
    normalized.includes("collab") ||
    normalized.includes("delegate") ||
    normalized.includes("agent")
  ) {
    return "collab_agent_tool_call";
  }
  if (normalized.startsWith("mcp") || normalized.includes("__")) return "mcp_tool_call";
  return "dynamic_tool_call";
}

function pathCandidates(value: unknown): ReadonlyArray<string> {
  const paths = new Set<string>();
  const visit = (candidate: unknown, key = "") => {
    if (typeof candidate === "string") {
      if (
        /(?:path|file|image|artifact|target|destination)/i.test(key) ||
        /^(?:[a-zA-Z]:[\\/]|\/|\.\.?[\\/])/.test(candidate.trim())
      ) {
        const trimmed = candidate.trim();
        if (trimmed) paths.add(trimmed);
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, key);
      return;
    }
    const record = asRecord(candidate);
    if (!record) return;
    for (const [childKey, child] of Object.entries(record)) visit(child, childKey);
  };
  visit(value);
  return [...paths];
}

function activityFromTool(input: {
  readonly id: string;
  readonly name: string;
  readonly rawInput: unknown;
  readonly rawOutput: unknown;
  readonly createdAt: string;
  readonly sequence: number;
  readonly failed?: boolean;
}): ImportedChatActivity {
  const itemType = toolItemType(input.name);
  const outputRecord = asRecord(input.rawOutput);
  const failed =
    input.failed === true ||
    outputRecord?.error !== undefined ||
    outputRecord?.status === "failed" ||
    outputRecord?.status === "error";
  const detail =
    stringValue(outputRecord?.error) ??
    stringValue(outputRecord?.message) ??
    (failed ? contentText(input.rawOutput).slice(0, 1_000) : undefined);
  const files = [
    ...new Set([...pathCandidates(input.rawInput), ...pathCandidates(input.rawOutput)]),
  ];
  const commandInput = asRecord(input.rawInput);
  const command =
    stringValue(commandInput?.cmd) ??
    stringValue(commandInput?.command) ??
    stringValue(commandInput?.script);
  const stdout =
    stringValue(outputRecord?.stdout) ??
    stringValue(outputRecord?.output) ??
    (typeof input.rawOutput === "string" ? input.rawOutput : undefined);
  return {
    id: input.id,
    createdAt: input.createdAt,
    sequence: input.sequence,
    tone: failed ? "error" : "tool",
    summary: failed ? `${input.name} failed` : input.name,
    payload: {
      itemType,
      status: failed ? "failed" : "completed",
      ...(detail ? { detail } : {}),
      data: {
        toolCallId: input.id,
        toolName: input.name,
        kind:
          itemType === "command_execution"
            ? "execute"
            : itemType === "file_change"
              ? "edit"
              : itemType === "web_search"
                ? "search"
                : "other",
        ...(input.rawInput !== undefined ? { rawInput: input.rawInput } : {}),
        ...(input.rawOutput !== undefined ? { rawOutput: input.rawOutput } : {}),
        ...(command ? { command } : {}),
        ...(stdout ? { stdout } : {}),
        ...(files.length > 0 ? { files } : {}),
      },
    },
  };
}

export interface CodexTranscriptFile {
  readonly path: string;
  readonly contents: string;
}

export function parseCodexTranscript(
  file: CodexTranscriptFile,
  titleById: ReadonlyMap<string, string> = new Map(),
): ImportedChatSession | null {
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let model: string | undefined;
  let createdAt = "1970-01-01T00:00:00.000Z";
  const messages: ImportedChatMessage[] = [];
  const calls = new Map<
    string,
    { readonly name: string; readonly input: unknown; readonly createdAt: string }
  >();
  const activities: ImportedChatActivity[] = [];

  for (const [lineIndex, line] of file.contents.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let envelope: Record<string, unknown>;
    try {
      const decoded = JSON.parse(line) as unknown;
      const record = asRecord(decoded);
      if (!record) continue;
      envelope = record;
    } catch {
      continue;
    }
    const timestamp = isoTimestamp(envelope.timestamp, createdAt);
    const payload = asRecord(envelope.payload);
    if (envelope.type === "session_meta" && payload) {
      sessionId = stringValue(payload.id) ?? sessionId;
      cwd = stringValue(payload.cwd) ?? cwd;
      createdAt = isoTimestamp(payload.timestamp, timestamp);
      model = stringValue(payload.model_provider) ?? model;
      continue;
    }
    if (envelope.type === "turn_context" && payload) {
      cwd = stringValue(payload.cwd) ?? cwd;
      model = stringValue(payload.model) ?? model;
      continue;
    }
    if (envelope.type !== "response_item" || !payload) continue;
    if (payload.type === "message" && (payload.role === "user" || payload.role === "assistant")) {
      const text = contentText(payload.content).trim();
      if (!text) continue;
      messages.push({
        id: `${lineIndex}`,
        role: payload.role,
        text,
        createdAt: timestamp,
      });
      continue;
    }
    if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      const callId = stringValue(payload.call_id) ?? `${lineIndex}`;
      const name = stringValue(payload.name) ?? stringValue(payload.tool) ?? "Tool call";
      calls.set(callId, {
        name,
        input: parseJson(payload.arguments ?? payload.input),
        createdAt: timestamp,
      });
      continue;
    }
    if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      const callId = stringValue(payload.call_id) ?? `${lineIndex}`;
      const call = calls.get(callId);
      activities.push(
        activityFromTool({
          id: callId,
          name: call?.name ?? "Tool call",
          rawInput: call?.input,
          rawOutput: parseJson(payload.output),
          createdAt: timestamp,
          sequence: activities.length,
        }),
      );
    }
  }

  if (!sessionId || (messages.length === 0 && activities.length === 0)) return null;
  const firstUserText = messages.find((message) => message.role === "user")?.text;
  const title =
    titleById.get(sessionId) ??
    firstUserText?.replace(/\s+/g, " ").trim().slice(0, 160) ??
    "Codex chat";
  return {
    id: sessionId,
    title,
    ...(cwd ? { cwd } : {}),
    ...(model ? { model } : {}),
    createdAt,
    messages,
    activities,
  };
}

interface OpenCodeSessionRow {
  readonly id: unknown;
  readonly directory: unknown;
  readonly title: unknown;
  readonly model: unknown;
  readonly time_created: unknown;
}

interface OpenCodeMessageRow {
  readonly id: unknown;
  readonly session_id: unknown;
  readonly time_created: unknown;
  readonly data: unknown;
}

interface OpenCodePartRow {
  readonly id: unknown;
  readonly message_id: unknown;
  readonly time_created: unknown;
  readonly data: unknown;
}

export function parseOpenCodeRows(input: {
  readonly sessions: ReadonlyArray<OpenCodeSessionRow>;
  readonly messages: ReadonlyArray<OpenCodeMessageRow>;
  readonly parts: ReadonlyArray<OpenCodePartRow>;
}): ReadonlyArray<ImportedChatSession> {
  const partsByMessage = new Map<string, OpenCodePartRow[]>();
  for (const part of input.parts) {
    const messageId = stringValue(part.message_id);
    if (!messageId) continue;
    const list = partsByMessage.get(messageId) ?? [];
    list.push(part);
    partsByMessage.set(messageId, list);
  }
  const messagesBySession = new Map<string, OpenCodeMessageRow[]>();
  for (const message of input.messages) {
    const sessionId = stringValue(message.session_id);
    if (!sessionId) continue;
    const list = messagesBySession.get(sessionId) ?? [];
    list.push(message);
    messagesBySession.set(sessionId, list);
  }

  return input.sessions.flatMap((session) => {
    const sessionId = stringValue(session.id);
    if (!sessionId) return [];
    const messages: ImportedChatMessage[] = [];
    const activities: ImportedChatActivity[] = [];
    for (const message of messagesBySession.get(sessionId) ?? []) {
      const messageId = stringValue(message.id);
      if (!messageId) continue;
      const data = asRecord(parseJson(message.data));
      const role = data?.role;
      const parts = (partsByMessage.get(messageId) ?? []).toSorted(
        (left, right) => Number(left.time_created) - Number(right.time_created),
      );
      if (role === "user" || role === "assistant") {
        const text = parts
          .flatMap((part) => {
            const value = asRecord(parseJson(part.data));
            return value?.type === "text" && stringValue(value.text)
              ? [stringValue(value.text)!]
              : [];
          })
          .join("\n\n")
          .trim();
        if (text) {
          messages.push({
            id: messageId,
            role,
            text,
            createdAt: isoTimestamp(message.time_created),
          });
        }
      }
      for (const part of parts) {
        const partId = stringValue(part.id);
        const value = asRecord(parseJson(part.data));
        if (!partId || value?.type !== "tool") continue;
        const state = asRecord(value.state);
        const status = stringValue(state?.status);
        activities.push(
          activityFromTool({
            id: partId,
            name: stringValue(value.tool) ?? "Tool call",
            rawInput: state?.input,
            rawOutput: state?.output,
            createdAt: isoTimestamp(part.time_created ?? message.time_created),
            sequence: activities.length,
            failed: status === "error" || status === "failed",
          }),
        );
      }
    }
    if (messages.length === 0 && activities.length === 0) return [];
    const modelRecord = asRecord(parseJson(session.model));
    const model = stringValue(modelRecord?.id);
    const cwd = stringValue(session.directory);
    return [
      {
        id: sessionId,
        title: stringValue(session.title) ?? "OpenCode chat",
        ...(cwd ? { cwd } : {}),
        ...(model ? { model } : {}),
        createdAt: isoTimestamp(session.time_created),
        messages,
        activities,
      },
    ];
  });
}

const resolveImportConfig = Effect.fn("LocalChatImport.resolveConfig")(function* (
  settings: ServerSettings,
  input: LocalChatImportInput,
): Effect.fn.Return<ResolvedImportConfig, LocalChatImportError> {
  const instanceId =
    input.instanceId ?? ProviderInstanceId.make(input.platform === "codex" ? "codex" : "opencode");
  const instance = settings.providerInstances[instanceId];
  if (instance !== undefined && instance.driver !== input.platform) {
    return yield* importError(
      input.platform,
      `Provider instance '${instanceId}' is not a ${input.platform} instance.`,
    );
  }
  const rawConfig = instance?.config ?? settings.providers[input.platform];
  const config =
    input.platform === "codex"
      ? yield* decodeCodexSettings(rawConfig).pipe(
          Effect.mapError((cause) =>
            importError("codex", "The Codex provider settings are invalid.", cause),
          ),
        )
      : yield* decodeOpenCodeSettings(rawConfig).pipe(
          Effect.mapError((cause) =>
            importError("opencode", "The OpenCode provider settings are invalid.", cause),
          ),
        );
  return {
    platform: input.platform,
    instanceId,
    environment: mergeProviderInstanceEnvironment(instance?.environment),
    config,
  } satisfies ResolvedImportConfig;
});

const loadCodexSessions = Effect.fn("LocalChatImport.loadCodexSessions")(function* (
  resolved: ResolvedImportConfig,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const layout = yield* resolveCodexHomeLayout(resolved.config as CodexSettings);
  const home = layout.sharedHomePath;
  const titleById = new Map<string, string>();
  const indexPath = path.join(home, "session_index.jsonl");
  const indexContents = yield* fileSystem
    .readFileString(indexPath)
    .pipe(Effect.orElseSucceed(() => ""));
  for (const line of indexContents.split(/\r?\n/)) {
    const value = asRecord(parseJson(line));
    const id = stringValue(value?.id);
    const title = stringValue(value?.thread_name);
    if (id && title) titleById.set(id, title);
  }
  const transcriptPaths: string[] = [];
  for (const directoryName of ["sessions", "archived_sessions"]) {
    const directory = path.join(home, directoryName);
    const entries = yield* fileSystem
      .readDirectory(directory, { recursive: true })
      .pipe(Effect.orElseSucceed(() => [] as string[]));
    for (const entry of entries) {
      if (entry.toLowerCase().endsWith(".jsonl")) transcriptPaths.push(path.join(directory, entry));
    }
  }
  const parsed = yield* Effect.forEach(
    transcriptPaths,
    (transcriptPath) =>
      fileSystem.readFileString(transcriptPath).pipe(
        Effect.map((contents) =>
          parseCodexTranscript({ path: transcriptPath, contents }, titleById),
        ),
        Effect.orElseSucceed(() => null),
      ),
    { concurrency: 8 },
  );
  const unique = new Map<string, ImportedChatSession>();
  for (const session of parsed) if (session) unique.set(session.id, session);
  return [...unique.values()];
});

const loadOpenCodeSessions = Effect.fn("LocalChatImport.loadOpenCodeSessions")(function* (
  resolved: ResolvedImportConfig,
) {
  const path = yield* Path.Path;
  const configuredDataRoot =
    stringValue(resolved.environment.OPENCODE_DATA_DIR) ??
    stringValue(resolved.environment.XDG_DATA_HOME) ??
    path.join(NodeOS.homedir(), ".local", "share");
  const databasePath =
    stringValue(resolved.environment.OPENCODE_DB_PATH) ??
    path.join(expandHomePath(configuredDataRoot), "opencode", "opencode.db");
  return yield* Effect.try({
    try: () => {
      const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
      try {
        return parseOpenCodeRows({
          sessions: database
            .prepare(
              "SELECT id, directory, title, model, time_created FROM session ORDER BY time_created",
            )
            .all() as unknown as OpenCodeSessionRow[],
          messages: database
            .prepare(
              "SELECT id, session_id, time_created, data FROM message ORDER BY session_id, time_created",
            )
            .all() as unknown as OpenCodeMessageRow[],
          parts: database
            .prepare(
              "SELECT id, message_id, time_created, data FROM part ORDER BY message_id, time_created",
            )
            .all() as unknown as OpenCodePartRow[],
        });
      } finally {
        database.close();
      }
    },
    catch: (cause) => importError("opencode", `Could not read '${databasePath}'.`, cause),
  });
});

const sessionIdFromResumeCursor = (cursor: unknown): string | undefined => {
  const record = asRecord(cursor);
  return stringValue(record?.sessionId);
};

export const importLocalChatsWithSettings = Effect.fn("importLocalChatsWithSettings")(function* (
  settings: ServerSettings,
  input: LocalChatImportInput,
): Effect.fn.Return<
  LocalChatImportResult,
  LocalChatImportError,
  | FileSystem.FileSystem
  | OrchestrationEngine.OrchestrationEngineService
  | Path.Path
  | ProjectionSnapshotQuery.ProjectionSnapshotQuery
  | ProviderSessionDirectory.ProviderSessionDirectory
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const projection = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const resolved = yield* resolveImportConfig(settings, input);
  const sessions = yield* resolved.platform === "codex"
    ? loadCodexSessions(resolved)
    : loadOpenCodeSessions(resolved);
  const snapshot = yield* projection
    .getShellSnapshot()
    .pipe(
      Effect.mapError((cause) =>
        importError(input.platform, "Could not read existing T3 threads.", cause),
      ),
    );
  const bindings = yield* directory
    .listBindings()
    .pipe(
      Effect.mapError((cause) =>
        importError(input.platform, "Could not read provider bindings.", cause),
      ),
    );
  const importedSessionIds = new Set(
    bindings
      .filter(
        (binding) =>
          binding.provider === resolved.platform &&
          binding.providerInstanceId === resolved.instanceId,
      )
      .flatMap((binding) => {
        const sessionId = sessionIdFromResumeCursor(binding.resumeCursor);
        return sessionId ? [sessionId] : [];
      }),
  );
  const projectsByRoot = new Map(
    snapshot.projects.map((project) => [path.resolve(project.workspaceRoot), project.id]),
  );
  const virtualRoot = path.join(NodeOS.homedir(), ".t3", "imports", resolved.platform);
  yield* fileSystem
    .makeDirectory(virtualRoot, { recursive: true })
    .pipe(
      Effect.mapError((cause) =>
        importError(input.platform, "Could not prepare the ungrouped chat workspace.", cause),
      ),
    );
  let skipped = 0;
  const pending: Array<{
    readonly session: ImportedChatSession;
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
  }> = [];
  for (const session of sessions) {
    if (importedSessionIds.has(session.id)) {
      skipped += 1;
      continue;
    }
    const requestedRoot = session.cwd ? path.resolve(expandHomePath(session.cwd)) : undefined;
    const workspaceRoot = requestedRoot
      ? yield* fileSystem.stat(requestedRoot).pipe(
          Effect.map((info) => (info.type === "Directory" ? requestedRoot : virtualRoot)),
          Effect.orElseSucceed(() => virtualRoot),
        )
      : virtualRoot;
    const threadId = ThreadId.make(`${resolved.platform}-import:${session.id}`);
    let projectId = projectsByRoot.get(path.resolve(workspaceRoot));
    if (!projectId) {
      projectId = ProjectId.make(
        `${resolved.platform}-import-project:${Buffer.from(path.resolve(workspaceRoot)).toString("base64url")}`,
      );
      const projectCommand: OrchestrationCommand = {
        type: "project.create",
        commandId: CommandId.make(`${resolved.platform}-import:project:${projectId}`),
        projectId,
        title:
          workspaceRoot === virtualRoot
            ? "Chats not in a project"
            : path.basename(workspaceRoot) || `${resolved.platform} imports`,
        workspaceRoot,
        defaultModelSelection: {
          instanceId: resolved.instanceId,
          model: session.model ?? resolved.platform,
        },
        createdAt: session.createdAt,
      };
      yield* engine
        .dispatch(projectCommand)
        .pipe(
          Effect.mapError((cause) =>
            importError(input.platform, `Could not prepare project '${workspaceRoot}'.`, cause),
          ),
        );
      projectsByRoot.set(path.resolve(workspaceRoot), projectId);
    }
    pending.push({ session, projectId, threadId });
  }

  const outcomes = yield* Effect.forEach(
    pending,
    ({ session, projectId, threadId }) => {
      const importOne = Effect.gen(function* () {
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${resolved.platform}-import:thread:${session.id}`),
          threadId,
          projectId,
          title: session.title.slice(0, 160),
          modelSelection: {
            instanceId: resolved.instanceId,
            model: session.model ?? resolved.platform,
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: session.createdAt,
        });
        yield* engine.dispatch({
          type: "thread.history.import",
          commandId: CommandId.make(`${resolved.platform}-import:history:${session.id}`),
          threadId,
          messages: session.messages.map((message) => ({
            messageId: MessageId.make(
              `${resolved.platform}-import-message:${session.id}:${message.id}`,
            ),
            role: message.role,
            text: message.text,
            createdAt: message.createdAt,
          })),
          activities: session.activities.map((activity) => ({
            id: EventId.make(`${resolved.platform}-import-activity:${session.id}:${activity.id}`),
            tone: activity.tone,
            kind: "tool.completed",
            summary: activity.summary,
            payload: activity.payload,
            turnId: null,
            sequence: activity.sequence,
            createdAt: activity.createdAt,
          })),
        });
        yield* directory.upsert({
          threadId,
          provider: ProviderDriverKind.make(resolved.platform),
          providerInstanceId: resolved.instanceId,
          status: "stopped",
          runtimeMode: "full-access",
          resumeCursor: { schemaVersion: 1, sessionId: session.id },
          runtimePayload: {
            modelSelection: {
              instanceId: resolved.instanceId,
              model: session.model ?? resolved.platform,
            },
            importedFrom: resolved.platform,
          },
        });
        yield* engine.dispatch({
          type: "thread.settle",
          commandId: CommandId.make(`${resolved.platform}-import:settle:${session.id}`),
          threadId,
        });
      }).pipe(
        Effect.mapError((cause) =>
          importError(input.platform, `Could not import session '${session.id}'.`, cause),
        ),
      );
      return Effect.exit(importOne).pipe(Effect.map((exit) => ({ session, exit })));
    },
    { concurrency: 4 },
  );
  let imported = 0;
  let failed = 0;
  for (const { session, exit } of outcomes) {
    if (exit._tag === "Failure") {
      failed += 1;
      yield* Effect.logWarning("Local chat import failed.", {
        platform: input.platform,
        sessionId: session.id,
        cause: exit.cause,
      });
    } else {
      importedSessionIds.add(session.id);
      imported += 1;
    }
  }
  return { discovered: sessions.length, imported, skipped, failed };
});
