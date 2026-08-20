import * as NodeOS from "node:os";

import {
  CommandId,
  EventId,
  HermesImportSessionsError,
  type HermesImportSessionsInput,
  type HermesImportSessionsResult,
  HermesSettings,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { collectStreamAsString } from "./providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";
import * as ProviderSessionDirectory from "./Services/ProviderSessionDirectory.ts";

export interface HermesExportMessage {
  readonly id?: unknown;
  readonly role?: unknown;
  readonly content?: unknown;
  readonly timestamp?: unknown;
  readonly tool_call_id?: unknown;
  readonly tool_calls?: unknown;
  readonly tool_name?: unknown;
  readonly display_kind?: unknown;
}

export interface HermesExportSession {
  readonly id?: unknown;
  readonly source?: unknown;
  readonly parent_session_id?: unknown;
  readonly title?: unknown;
  readonly display_name?: unknown;
  readonly model?: unknown;
  readonly cwd?: unknown;
  readonly git_repo_root?: unknown;
  readonly started_at?: unknown;
  readonly ended_at?: unknown;
  readonly messages?: unknown;
}

interface ResolvedHermesImportConfig {
  readonly settings: HermesSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly instanceId: ProviderInstanceId;
}

const decodeHermesSettings = Schema.decodeUnknownEffect(HermesSettings);

function importError(reason: string, cause?: unknown) {
  return new HermesImportSessionsError({
    reason,
    ...(cause === undefined ? {} : { cause }),
  });
}

function resolveImportConfig(
  settings: ServerSettings,
  input: HermesImportSessionsInput,
): Effect.Effect<ResolvedHermesImportConfig, HermesImportSessionsError> {
  const instanceId = input.instanceId ?? ProviderInstanceId.make("hermes");
  const instance = settings.providerInstances[instanceId];

  if (instance !== undefined && instance.driver !== "hermes") {
    return Effect.fail(importError(`Provider instance '${instanceId}' is not a Hermes instance.`));
  }

  const rawSettings =
    instance?.config ?? (instanceId === "hermes" ? settings.providers.hermes : undefined);
  if (rawSettings === undefined) {
    return Effect.fail(importError(`Hermes provider instance '${instanceId}' was not found.`));
  }

  return decodeHermesSettings(rawSettings).pipe(
    Effect.map((providerSettings) => ({
      settings: providerSettings,
      environment: mergeProviderInstanceEnvironment(instance?.environment),
      instanceId,
    })),
    Effect.mapError((cause) => importError("The Hermes provider settings are invalid.", cause)),
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Hermes marks spawned child-agent conversations explicitly. A parent id is
 * not sufficient: ordinary CLI and Telegram continuations can have one too. */
export function isHermesSubagentSession(session: HermesExportSession): boolean {
  return stringValue(session.source)?.toLowerCase() === "subagent";
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(messageText).filter(Boolean).join("\n\n");
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (typeof record.content === "string") return record.content;
  }
  return "";
}

function isoTimestamp(value: unknown, fallback: string): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
    const parsed = DateTime.make(milliseconds);
    if (Option.isSome(parsed)) return DateTime.formatIso(parsed.value);
  }
  if (typeof value === "string") {
    const parsed = DateTime.make(value);
    if (Option.isSome(parsed)) return DateTime.formatIso(parsed.value);
  }
  return fallback;
}

export function hermesSessionMessages(session: HermesExportSession): ReadonlyArray<{
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}> {
  if (!Array.isArray(session.messages)) return [];
  const fallback = isoTimestamp(session.started_at, "1970-01-01T00:00:00.000Z");
  return session.messages.flatMap((raw, index) => {
    if (!raw || typeof raw !== "object") return [];
    const message = raw as HermesExportMessage;
    if (message.role !== "user" && message.role !== "assistant") return [];
    const text = messageText(message.content).trim();
    if (!text) return [];
    return [
      {
        id: String(message.id ?? index),
        role: message.role,
        text,
        createdAt: isoTimestamp(message.timestamp, fallback),
      },
    ];
  });
}

type HermesToolItemType =
  | "command_execution"
  | "file_change"
  | "mcp_tool_call"
  | "dynamic_tool_call"
  | "collab_agent_tool_call"
  | "web_search"
  | "image_view";

interface HermesToolCall {
  readonly id: string;
  readonly name?: string;
  readonly input?: unknown;
}

export interface HermesSessionActivity {
  readonly id: string;
  readonly createdAt: string;
  readonly sequence: number;
  readonly tone: "tool" | "error";
  readonly summary: string;
  readonly payload: {
    readonly itemType: HermesToolItemType;
    readonly status: "completed" | "failed";
    readonly detail?: string;
    readonly data: Record<string, unknown>;
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Some Hermes tools wrap JSON in an untrusted-result envelope. Retain the
    // original text, but recover the structured body when one is present.
    const firstObject = trimmed.indexOf("{");
    const lastObject = trimmed.lastIndexOf("}");
    if (firstObject >= 0 && lastObject > firstObject) {
      try {
        return JSON.parse(trimmed.slice(firstObject, lastObject + 1)) as unknown;
      } catch {
        return value;
      }
    }
    return value;
  }
}

function hermesToolCalls(value: unknown): ReadonlyArray<HermesToolCall> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw, index) => {
    const call = asRecord(raw);
    const fn = asRecord(call?.function);
    if (!call) return [];
    const id = stringValue(call.id) ?? stringValue(call.call_id) ?? String(index);
    const name = stringValue(fn?.name) ?? stringValue(call.name);
    const rawInput = fn?.arguments ?? call.arguments ?? call.input;
    return [{ id, ...(name ? { name } : {}), input: parseJsonValue(rawInput) }];
  });
}

function hermesToolItemType(name: string): HermesToolItemType {
  const normalized = name.toLowerCase();
  if (["terminal", "execute_code", "process"].includes(normalized)) return "command_execution";
  if (["patch", "write_file", "file_edit", "apply_patch"].includes(normalized)) {
    return "file_change";
  }
  if (normalized === "web_search" || normalized === "web_extract") return "web_search";
  if (
    normalized === "vision_analyze" ||
    normalized === "image_view" ||
    normalized.includes("screenshot")
  ) {
    return "image_view";
  }
  if (normalized === "delegate_task") return "collab_agent_tool_call";
  return "dynamic_tool_call";
}

function displayToolName(name: string): string {
  return name
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

function toolCommand(input: unknown): unknown {
  const record = asRecord(input);
  return record?.command ?? record?.cmd ?? record?.code;
}

function isFailedToolOutput(output: unknown): boolean {
  const record = asRecord(output);
  if (!record) return false;
  if (record.success === false || record.ok === false) return true;
  if (typeof record.exit_code === "number" && record.exit_code !== 0) return true;
  if (typeof record.exitCode === "number" && record.exitCode !== 0) return true;
  return typeof record.error === "string" && record.error.trim().length > 0;
}

function toolOutputRecord(content: unknown): Record<string, unknown> {
  const text = messageText(content).trim();
  const parsed = parseJsonValue(text);
  const record = asRecord(parsed);
  if (record) {
    // Hermes' terminal tool calls its primary stream `output`; the T3 work-log
    // renderer understands `stdout`. Keep both the exact export and the alias.
    return typeof record.output === "string" && record.stdout === undefined
      ? { ...record, stdout: record.output }
      : record;
  }
  return text ? { content: text } : {};
}

function outputDetail(output: Record<string, unknown>): string | undefined {
  for (const candidate of [
    output.error,
    output.stderr,
    output.output,
    output.stdout,
    output.content,
  ]) {
    if (typeof candidate !== "string") continue;
    const firstLine = candidate
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean);
    if (firstLine) return firstLine.slice(0, 240);
  }
  return undefined;
}

function changedFilesFromOutput(output: Record<string, unknown>): ReadonlyArray<{ path: string }> {
  const candidates = [
    output.resolved_path,
    output.path,
    output.output_path,
    output.screenshot_path,
    output.artifact_path,
    ...(Array.isArray(output.files_modified) ? output.files_modified : []),
    ...(Array.isArray(output.files_created) ? output.files_created : []),
  ];
  const seen = new Set<string>();
  return candidates.flatMap((candidate) => {
    const path = stringValue(candidate);
    if (!path || seen.has(path)) return [];
    seen.add(path);
    return [{ path }];
  });
}

/**
 * Converts Hermes tool-result rows into the same completed work-log activities
 * used by live provider runtimes. Full input/output payloads remain persisted;
 * snapshots apply the normal T3 payload projection before reaching clients.
 */
export function hermesSessionActivities(
  session: HermesExportSession,
): ReadonlyArray<HermesSessionActivity> {
  if (!Array.isArray(session.messages)) return [];
  const fallback = isoTimestamp(session.started_at, "1970-01-01T00:00:00.000Z");
  const calls = new Map<string, HermesToolCall>();
  const activities: HermesSessionActivity[] = [];

  for (const [index, raw] of session.messages.entries()) {
    const message = asRecord(raw) as HermesExportMessage | undefined;
    if (!message) continue;
    for (const call of hermesToolCalls(message.tool_calls)) calls.set(call.id, call);
    if (message.role !== "tool" || message.display_kind === "hidden") continue;

    const callId = stringValue(message.tool_call_id) ?? `tool-${index}`;
    const call = calls.get(callId);
    const name = stringValue(message.tool_name) ?? call?.name ?? "tool";
    const itemType = hermesToolItemType(name);
    const rawOutput = toolOutputRecord(message.content);
    const failed = isFailedToolOutput(rawOutput);
    const files =
      itemType === "file_change" || itemType === "image_view"
        ? changedFilesFromOutput(rawOutput)
        : [];
    const command = itemType === "command_execution" ? toolCommand(call?.input) : undefined;
    const item: Record<string, unknown> = {
      type: name,
      ...(call?.input !== undefined ? { input: call.input } : {}),
      ...(command !== undefined ? { command } : {}),
    };
    const detail =
      itemType === "command_execution"
        ? typeof command === "string"
          ? command
          : outputDetail(rawOutput)
        : outputDetail(rawOutput);

    activities.push({
      id: String(message.id ?? callId),
      createdAt: isoTimestamp(message.timestamp, fallback),
      sequence: index,
      tone: failed ? "error" : "tool",
      summary: displayToolName(name) || "Tool",
      payload: {
        itemType,
        status: failed ? "failed" : "completed",
        ...(detail ? { detail } : {}),
        data: {
          toolCallId: callId,
          toolName: name,
          kind:
            itemType === "command_execution"
              ? "execute"
              : itemType === "file_change"
                ? "edit"
                : itemType === "web_search"
                  ? "search"
                  : "other",
          ...(call?.input !== undefined ? { rawInput: call.input } : {}),
          rawOutput,
          item,
          ...(files.length > 0 ? { files } : {}),
        },
      },
    });
  }

  return activities;
}

export function hermesSessionTitle(
  session: HermesExportSession,
  messages: ReturnType<typeof hermesSessionMessages>,
) {
  const explicit = stringValue(session.title) ?? stringValue(session.display_name);
  const seed =
    explicit ?? messages.find((message) => message.role === "user")?.text ?? "Hermes chat";
  return seed.replace(/\s+/g, " ").trim().slice(0, 160) || "Hermes chat";
}

export function parseHermesSessionsExport(
  stdout: string,
): Effect.Effect<ReadonlyArray<HermesExportSession>, HermesImportSessionsError> {
  const sessions: Array<HermesExportSession> = [];
  for (const [index, line] of stdout.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return Effect.fail(importError(`Hermes export line ${index + 1} is not a session object.`));
      }
      sessions.push(value as HermesExportSession);
    } catch (cause) {
      return Effect.fail(importError(`Hermes export line ${index + 1} is not valid JSON.`, cause));
    }
  }
  return Effect.succeed(sessions);
}

const sessionIdFromResumeCursor = (cursor: unknown): string | undefined => {
  if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
  return stringValue((cursor as Record<string, unknown>).sessionId);
};

export const importHermesSessionsWithSettings = Effect.fn("importHermesSessionsWithSettings")(
  function* (
    serverSettings: ServerSettings,
    input: HermesImportSessionsInput,
  ): Effect.fn.Return<
    HermesImportSessionsResult,
    HermesImportSessionsError,
    | ChildProcessSpawner.ChildProcessSpawner
    | FileSystem.FileSystem
    | OrchestrationEngine.OrchestrationEngineService
    | Path.Path
    | ProjectionSnapshotQuery.ProjectionSnapshotQuery
    | ProviderSessionDirectory.ProviderSessionDirectory
  > {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const engine = yield* OrchestrationEngine.OrchestrationEngineService;
    const projection = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
    const resolved = yield* resolveImportConfig(serverSettings, input);
    const env = {
      ...resolved.environment,
      ...(resolved.settings.homePath.trim()
        ? { HERMES_HOME: resolved.settings.homePath.trim() }
        : {}),
    };
    const command = resolved.settings.binaryPath || "hermes";
    const spawnCommand = yield* resolveSpawnCommand(command, ["sessions", "export", "-", "--yes"], {
      env,
    }).pipe(
      Effect.mapError((cause) => importError("Could not resolve the Hermes executable.", cause)),
    );
    const result = yield* Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env,
          shell: spawnCommand.shell,
        }),
      );
      const [stdout, stderr, code] = yield* Effect.all(
        [
          collectStreamAsString(child.stdout),
          collectStreamAsString(child.stderr),
          child.exitCode.pipe(Effect.map(Number)),
        ],
        { concurrency: "unbounded" },
      );
      return { stdout, stderr, code };
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) => importError("Could not run the Hermes session exporter.", cause)),
    );

    if (result.code !== 0) {
      return yield* importError(
        result.stderr.trim() || `Hermes session exporter exited with code ${result.code}.`,
      );
    }

    const sessions = yield* parseHermesSessionsExport(result.stdout);
    const snapshot = yield* projection
      .getShellSnapshot()
      .pipe(Effect.mapError((cause) => importError("Could not read existing T3 threads.", cause)));
    const bindings = yield* directory
      .listBindings()
      .pipe(Effect.mapError((cause) => importError("Could not read provider bindings.", cause)));
    const hermesBindingsBySessionId = new Map<string, (typeof bindings)[number]>();
    for (const binding of bindings) {
      if (binding.provider !== "hermes" || binding.providerInstanceId !== resolved.instanceId) {
        continue;
      }
      const sessionId = sessionIdFromResumeCursor(binding.resumeCursor);
      if (sessionId) hermesBindingsBySessionId.set(sessionId, binding);
    }
    const importedHermesSessionIds = new Set(hermesBindingsBySessionId.keys());
    const visibleThreadIds = new Set(snapshot.threads.map((thread) => thread.id));
    const projectsByRoot = new Map(
      snapshot.projects.map((project) => [project.workspaceRoot, project.id]),
    );
    const ungroupedRoot = path.join(NodeOS.homedir(), ".t3", "imports", "hermes");
    yield* fileSystem
      .makeDirectory(ungroupedRoot, { recursive: true })
      .pipe(
        Effect.mapError((cause) =>
          importError("Could not prepare the ungrouped Hermes chat workspace.", cause),
        ),
      );

    let imported = 0;
    let removedSubagents = 0;
    let skipped = 0;
    let failed = 0;
    const importedAt = DateTime.formatIso(yield* DateTime.now);

    for (const session of sessions) {
      const hermesSessionId = stringValue(session.id);
      if (!hermesSessionId) {
        failed += 1;
        continue;
      }
      const threadId = ThreadId.make(`hermes-import:${hermesSessionId}`);
      if (isHermesSubagentSession(session)) {
        const importedThreadId =
          hermesBindingsBySessionId.get(hermesSessionId)?.threadId ?? threadId;
        if (!visibleThreadIds.has(importedThreadId)) {
          skipped += 1;
          continue;
        }

        const deletedExit = yield* Effect.exit(
          engine.dispatch({
            type: "thread.delete",
            commandId: CommandId.make(`hermes-import:delete-subagent:${hermesSessionId}`),
            threadId: importedThreadId,
          }),
        );
        if (deletedExit._tag === "Failure") {
          failed += 1;
          yield* Effect.logWarning("Could not remove an imported Hermes subagent session.", {
            hermesSessionId,
            threadId: importedThreadId,
            cause: deletedExit.cause,
          });
        } else {
          visibleThreadIds.delete(importedThreadId);
          removedSubagents += 1;
          skipped += 1;
        }
        continue;
      }
      if (importedHermesSessionIds.has(hermesSessionId)) {
        skipped += 1;
        continue;
      }

      const messages = hermesSessionMessages(session);
      const activities = hermesSessionActivities(session);
      if (messages.length === 0 && activities.length === 0) {
        skipped += 1;
        continue;
      }

      const requestedRoot = stringValue(session.git_repo_root) ?? stringValue(session.cwd);
      const workspaceRoot = requestedRoot
        ? yield* fileSystem.stat(requestedRoot).pipe(
            Effect.map((info) => (info.type === "Directory" ? requestedRoot : ungroupedRoot)),
            Effect.orElseSucceed(() => ungroupedRoot),
          )
        : ungroupedRoot;

      const importOne = Effect.gen(function* () {
        let projectId = projectsByRoot.get(workspaceRoot);
        if (!projectId) {
          projectId = ProjectId.make(
            `hermes-import-project:${Buffer.from(workspaceRoot).toString("base64url")}`,
          );
          const createdAt = isoTimestamp(session.started_at, importedAt);
          const projectCommand: OrchestrationCommand = {
            type: "project.create",
            commandId: CommandId.make(`hermes-import:project:${projectId}`),
            projectId,
            title:
              workspaceRoot === ungroupedRoot
                ? "Chats not in a project"
                : path.basename(workspaceRoot) || "Hermes Imports",
            workspaceRoot,
            defaultModelSelection: {
              instanceId: resolved.instanceId,
              model: "hermes-agent",
            },
            createdAt,
          };
          yield* engine.dispatch(projectCommand);
          projectsByRoot.set(workspaceRoot, projectId);
        }

        const createdAt = isoTimestamp(
          session.started_at,
          messages[0]?.createdAt ?? activities[0]?.createdAt ?? importedAt,
        );
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`hermes-import:thread:${hermesSessionId}`),
          threadId,
          projectId,
          title: hermesSessionTitle(session, messages),
          modelSelection: {
            instanceId: resolved.instanceId,
            model: "hermes-agent",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        });

        yield* engine.dispatch({
          type: "thread.history.import",
          commandId: CommandId.make(`hermes-import:history:${hermesSessionId}`),
          threadId,
          messages: messages.map((message) => ({
            messageId: MessageId.make(`hermes-import-message:${hermesSessionId}:${message.id}`),
            role: message.role,
            text: message.text,
            createdAt: message.createdAt,
          })),
          activities: activities.map((activity) => ({
            id: EventId.make(`hermes-import-activity:${hermesSessionId}:${activity.id}`),
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
          provider: ProviderDriverKind.make("hermes"),
          providerInstanceId: resolved.instanceId,
          status: "stopped",
          runtimeMode: "full-access",
          resumeCursor: { schemaVersion: 1, sessionId: hermesSessionId },
          runtimePayload: {
            modelSelection: {
              instanceId: resolved.instanceId,
              model: "hermes-agent",
            },
            importedFrom: "hermes",
            ...(stringValue(session.model) ? { importedModel: stringValue(session.model) } : {}),
          },
        });

        yield* engine.dispatch({
          type: "thread.settle",
          commandId: CommandId.make(`hermes-import:settle:${hermesSessionId}`),
          threadId,
        });
      }).pipe(
        Effect.mapError((cause) =>
          importError(`Could not import Hermes session '${hermesSessionId}'.`, cause),
        ),
      );

      const importedExit = yield* Effect.exit(importOne);
      if (importedExit._tag === "Failure") {
        failed += 1;
        yield* Effect.logWarning("Hermes session import failed.", {
          hermesSessionId,
          cause: importedExit.cause,
        });
        continue;
      }
      importedHermesSessionIds.add(hermesSessionId);
      imported += 1;
    }

    return { discovered: sessions.length, imported, removedSubagents, skipped, failed };
  },
);
