// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off globalConsoleInEffect:off globalJsonInEffect:off - Dev-only seeder for the mobile UI lab.
// Turns apps/mobile/scripts/lab/fixtures.mts into real V2 events in a lab server's database.
// Run by apps/mobile/scripts/lab/lab.mts: once with the server stopped, then with --live once it is up.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import {
  LAB_PRIMARY_THREAD,
  LAB_PROJECTS,
  LAB_THREADS,
  type LabEntry,
  type LabThread,
} from "../../mobile/scripts/lab/fixtures.mts";
import * as EventSink from "../src/orchestration-v2/EventSink.ts";
import * as EventStore from "../src/orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../src/orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../src/persistence/Sqlite.ts";

const [baseDir, workspaceBase] = process.argv.slice(2);
if (!baseDir || !workspaceBase) {
  console.error("Usage: mobile-lab-seed.ts <base-dir> <workspace-base>");
  process.exit(2);
}
const dbPath = NodePath.join(baseDir, "userdata", "statev2.sqlite");

const NOW = Number(process.env.LAB_SEED_NOW ?? Date.now());
const agoOf = (entry: LabEntry) =>
  entry.kind === "subagent" ? entry.startedMinutesAgo : entry.minutesAgo;
const at = (minutesAgo: number) => DateTime.makeUnsafe(NOW - minutesAgo * 60_000);
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const threadId = (key: string) => ThreadId.make(`lab-${key}`);
const projectId = (key: string) => ProjectId.make(`lab-project-${key}`);
const driverOf = (instanceId: string) =>
  ProviderDriverKind.make(instanceId === "codex" ? "codex" : "claudeAgent");

const layerDatabase = SqlitePersistence.layerFromPath(dbPath);
const layerStores = Layer.mergeAll(
  layerDatabase,
  EventStore.layer.pipe(Layer.provideMerge(layerDatabase)),
  ProjectionStore.layer.pipe(Layer.provideMerge(layerDatabase)),
);
const layerSeed = EventSink.layer.pipe(Layer.provideMerge(layerStores));

/** Wipe everything the fixtures own, keep auth and settings so the paired app stays signed in. */
const resetState = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string; readonly sql: string }>`
    SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`;
  const virtual = tables
    .filter((table) => /CREATE VIRTUAL/i.test(table.sql))
    .map((table) => table.name);
  const keep = /^(auth_|effect_sql_migrations|orchestration_v2_projection_metadata)/;
  for (const { name } of tables) {
    if (keep.test(name)) continue;
    // Full-text shadow tables follow their virtual table.
    if (virtual.some((table) => name.startsWith(`${table}_`))) continue;
    if (
      !/^(orchestration_|projection_)/.test(name) &&
      !/^(provider_session_runtime|legacy)/.test(name)
    )
      continue;
    yield* sql.unsafe(`DELETE FROM "${name}"`);
  }
  yield* sql`DELETE FROM sqlite_sequence WHERE name LIKE 'orchestration_%'`.pipe(Effect.ignore);
  yield* sql`UPDATE orchestration_v2_projection_metadata SET last_sequence = 0`.pipe(Effect.ignore);
});

/** With settings folded, a project's scripts live in its settings override, not on the project row. */
function seedProjectScripts(key: string, scripts: ReadonlyArray<unknown>) {
  const settingsPath = NodePath.join(baseDir!, "userdata", "settings.json");
  const settings = NodeFS.existsSync(settingsPath)
    ? JSON.parse(NodeFS.readFileSync(settingsPath, "utf8"))
    : {};
  const overrides = settings.projectSettingsOverrides ?? {};
  overrides[projectId(key)] = { ...overrides[projectId(key)], defaultProjectScripts: scripts };
  NodeFS.writeFileSync(
    settingsPath,
    `${JSON.stringify({ ...settings, projectSettingsOverrides: overrides }, null, 2)}\n`,
  );
}

const seedProjects = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const project of LAB_PROJECTS) {
    const root = NodePath.join(workspaceBase, project.directory);
    NodeFS.mkdirSync(root, { recursive: true });
    const model = JSON.stringify({ instanceId: "claudeAgent", model: "claude-opus-5-5" });
    yield* sql`
      INSERT OR REPLACE INTO projection_projects (
        project_id, title, has_custom_title, workspace_root, default_model_selection_json,
        default_thread_env_mode, auto_pull, favicon_path, project_icon_json, scripts_json,
        pinned_at, archived_at, created_at, updated_at, deleted_at
      ) VALUES (
        ${projectId(project.key)}, ${project.title}, 0, ${root}, ${model},
        NULL, 0, NULL, NULL, '[]', NULL, NULL, ${iso(60 * 24 * 30)}, ${iso(1)}, NULL
      )`;
    seedProjectScripts(project.key, project.scripts);
  }
});

/**
 * `liveMode` false writes the whole history with every running thing already finished: startup
 * recovery cancels running work, so live state is written after the server is up (`liveMode` true,
 * which returns only the events that turn the running run and child task back on).
 */
function eventsFor(
  thread: LabThread,
  liveMode: boolean,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const id = threadId(thread.key);
  const modelSelection = {
    instanceId: ProviderInstanceId.make(thread.instanceId),
    model: thread.model,
  };
  const events: OrchestrationV2DomainEvent[] = [];
  let eventCount = 0;
  const nextEventId = () =>
    EventId.make(`lab-event:${thread.key}:${liveMode ? "live" : "base"}:${++eventCount}`);
  const liveRunIds = new Set<string>();
  const oldest = Math.max(...thread.entries.map(agoOf), 1) + 5;

  events.push({
    id: nextEventId(),
    type: "thread.created",
    threadId: id,
    providerInstanceId: modelSelection.instanceId,
    occurredAt: at(oldest),
    payload: {
      createdBy: "user",
      creationSource: "web",
      id,
      projectId: projectId(thread.project),
      title: thread.title,
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: thread.branch ?? null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
      forkedFrom: null,
      createdAt: at(oldest),
      updatedAt: at(thread.minutesAgo),
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: at(thread.minutesAgo),
      deletedAt: null,
    },
  });

  let ordinal = 0;
  let runOrdinal = 0;
  let runId: RunId | null = null;
  let rootNodeId: NodeId | null = null;
  const base = (itemId: string, minutesAgo: number) => ({
    id: TurnItemId.make(`lab-item:${thread.key}:${itemId}`),
    threadId: id,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: ordinal++,
    status: "completed" as const,
    title: null,
    startedAt: at(minutesAgo),
    completedAt: at(minutesAgo),
    updatedAt: at(minutesAgo),
  });
  const pushItem = (item: OrchestrationV2TurnItem, minutesAgo: number) =>
    events.push({
      id: nextEventId(),
      type: "turn-item.updated",
      threadId: id,
      ...(runId === null ? {} : { runId }),
      occurredAt: at(minutesAgo),
      payload: item,
    });

  const startRun = (
    entry: Extract<LabEntry, { kind: "user" | "agentMessage" }>,
    messageId: MessageId,
    index: number,
  ) => {
    runOrdinal++;
    runId = RunId.make(`lab-run:${thread.key}:${runOrdinal}`);
    rootNodeId = NodeId.make(`lab-node:${thread.key}:root-${runOrdinal}`);
    const rest = thread.entries.slice(index + 1);
    const nextIndex = rest.findIndex(
      (other) => other.kind === "user" || other.kind === "agentMessage",
    );
    const nextEntry = nextIndex === -1 ? undefined : rest[nextIndex];
    // A run holding a running child task is itself still working; one holding a question waits.
    const following = nextIndex === -1 ? rest : rest.slice(0, nextIndex);
    const hasRunningTask = following.some(
      (other) => other.kind === "subagent" && other.status === "running",
    );
    const live = hasRunningTask || following.some((other) => other.kind === "userInput");
    const running = live && liveMode;
    if (live) liveRunIds.add(runId);
    const completedAgo = running ? null : nextEntry ? agoOf(nextEntry) + 0.1 : thread.minutesAgo;
    const status = running
      ? hasRunningTask
        ? ("running" as const)
        : ("waiting" as const)
      : ("completed" as const);
    events.push({
      id: nextEventId(),
      type: "node.updated",
      threadId: id,
      runId,
      occurredAt: at(entry.minutesAgo),
      payload: {
        id: rootNodeId,
        threadId: id,
        runId,
        parentNodeId: null,
        rootNodeId,
        kind: "root_turn",
        status,
        countsForRun: true,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: at(entry.minutesAgo),
        completedAt: completedAgo === null ? null : at(completedAgo),
      },
    });
    events.push({
      id: nextEventId(),
      type: "run.created",
      threadId: id,
      runId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: at(entry.minutesAgo),
      payload: {
        id: runId,
        threadId: id,
        ordinal: runOrdinal,
        providerInstanceId: modelSelection.instanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: messageId,
        rootNodeId,
        activeAttemptId: null,
        status,
        requestedAt: at(entry.minutesAgo),
        startedAt: at(entry.minutesAgo),
        completedAt: completedAgo === null ? null : at(completedAgo),
        checkpointId: null,
        contextHandoffId: null,
      },
    });
  };

  thread.entries.forEach((entry, index) => {
    const key = `${index}`;
    switch (entry.kind) {
      case "user":
      case "agentMessage": {
        const messageId = MessageId.make(`lab-message:${thread.key}:${key}`);
        startRun(entry, messageId, index);
        const fromAgent = entry.kind === "agentMessage";
        const creation = fromAgent
          ? ({ createdBy: "agent", creationSource: "mcp" } as const)
          : ({ createdBy: "user", creationSource: "mobile" } as const);
        const sender = fromAgent ? { senderThreadId: threadId(entry.from) } : {};
        events.push({
          id: nextEventId(),
          type: "message.updated",
          threadId: id,
          ...(runId === null ? {} : { runId }),
          occurredAt: at(entry.minutesAgo),
          payload: {
            ...creation,
            ...sender,
            id: messageId,
            threadId: id,
            runId,
            nodeId: null,
            role: "user",
            text: entry.text,
            attachments: [],
            streaming: false,
            createdAt: at(entry.minutesAgo),
            updatedAt: at(entry.minutesAgo),
          },
        });
        pushItem(
          {
            ...base(`user-${key}`, entry.minutesAgo),
            ...creation,
            ...sender,
            type: "user_message",
            messageId,
            text: entry.text,
            attachments: [],
            inputIntent: "turn_start",
          },
          entry.minutesAgo,
        );
        break;
      }
      case "assistant": {
        const messageId = MessageId.make(`lab-message:${thread.key}:${key}`);
        events.push({
          id: nextEventId(),
          type: "message.updated",
          threadId: id,
          ...(runId === null ? {} : { runId }),
          occurredAt: at(entry.minutesAgo),
          payload: {
            createdBy: "agent",
            creationSource: "provider",
            id: messageId,
            threadId: id,
            runId,
            nodeId: rootNodeId,
            role: "assistant",
            text: entry.text,
            attachments: [],
            streaming: false,
            createdAt: at(entry.minutesAgo),
            updatedAt: at(entry.minutesAgo),
          },
        });
        pushItem(
          {
            ...base(`assistant-${key}`, entry.minutesAgo),
            type: "assistant_message",
            messageId,
            text: entry.text,
            streaming: false,
          },
          entry.minutesAgo,
        );
        break;
      }
      case "delegatedNotice": {
        pushItem(
          {
            ...base(`notice-${key}`, entry.minutesAgo),
            type: "notification",
            source: { kind: "delegated_task", taskIds: [] },
            outcome: entry.outcome,
            summary: `Delegated task "${entry.task}" ${entry.outcome === "completed" ? "finished" : entry.outcome}`,
          },
          entry.minutesAgo,
        );
        break;
      }
      case "subagent": {
        const subagentId = NodeId.make(`lab-node:${thread.key}:subagent-${key}`);
        const running = entry.status === "running" && liveMode;
        const startedAgo = entry.startedMinutesAgo;
        const completedAgo = running
          ? null
          : Math.max(startedAgo - (entry.durationSeconds ?? 60) / 60, 0.2);
        const driver = driverOf(entry.instanceId);
        const subagentInstance = ProviderInstanceId.make(entry.instanceId);
        events.push({
          id: nextEventId(),
          type: "node.updated",
          threadId: id,
          ...(runId === null ? {} : { runId }),
          occurredAt: at(startedAgo),
          payload: {
            id: subagentId,
            threadId: id,
            runId,
            parentNodeId: rootNodeId,
            rootNodeId: rootNodeId ?? subagentId,
            kind: "subagent",
            status: running ? "running" : entry.status === "running" ? "completed" : entry.status,
            countsForRun: false,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: at(startedAgo),
            completedAt: completedAgo === null ? null : at(completedAgo),
          },
        });
        events.push({
          id: nextEventId(),
          type: "subagent.updated",
          threadId: id,
          ...(runId === null ? {} : { runId }),
          occurredAt: at(completedAgo ?? 0.2),
          payload: {
            id: subagentId,
            threadId: id,
            runId,
            parentNodeId: rootNodeId ?? subagentId,
            origin: "provider_native",
            createdBy: "agent",
            driver,
            providerInstanceId: subagentInstance,
            providerThreadId: null,
            childThreadId: null,
            nativeTaskRef: null,
            prompt: entry.prompt,
            title: entry.title,
            model: entry.model,
            modelSelection: { instanceId: subagentInstance, model: entry.model },
            status: running ? "running" : entry.status === "running" ? "completed" : entry.status,
            result: entry.result ?? null,
            startedAt: at(startedAgo),
            completedAt: completedAgo === null ? null : at(completedAgo),
            updatedAt: at(completedAgo ?? 0.2),
          },
        });
        pushItem(
          {
            ...base(`subagent-${key}`, startedAgo),
            status: running ? "running" : entry.status === "running" ? "completed" : entry.status,
            completedAt: completedAgo === null ? null : at(completedAgo),
            title: entry.title,
            type: "subagent",
            subagentId,
            origin: "provider_native",
            driver,
            providerInstanceId: subagentInstance,
            childThreadId: null,
            prompt: entry.prompt,
            result: entry.result ?? null,
          },
          startedAgo,
        );
        break;
      }
      case "taskReceipt": {
        const row = {
          id: entry.id,
          title: entry.title,
          status: entry.status,
          attention: null,
          project: { ...entry.project, code: null },
          workspace: null,
          pull_request: entry.pullRequest
            ? {
                number: entry.pullRequest.number,
                url: `https://github.com/lab/${entry.project.slug}/pull/${entry.pullRequest.number}`,
                state: entry.pullRequest.state,
              }
            : null,
          subtask_counts: {
            total: entry.subtasks.total,
            todo: entry.subtasks.total - entry.subtasks.completed,
            running: 0,
            completed: entry.subtasks.completed,
            failed: 0,
            cancelled: 0,
          },
          created_at: iso(entry.minutesAgo),
          updated_at: iso(entry.minutesAgo),
          last_activity_at: null,
        };
        pushItem(
          {
            ...base(`task-receipt-${key}`, entry.minutesAgo),
            type: "dynamic_tool",
            toolName: "mcp__orbit__task-create",
            input: { title: entry.title, project: entry.project.slug },
            // MCP content blocks, as a provider relays the Gateway's answer.
            output: [{ type: "text", text: JSON.stringify({ data: row }) }],
          },
          entry.minutesAgo,
        );
        break;
      }
      case "userInput": {
        // Startup recovery expires pending requests, so a question only exists in live mode.
        if (!liveMode || runId === null || rootNodeId === null) break;
        const requestId = RuntimeRequestId.make(`lab-request:${thread.key}:${key}`);
        events.push({
          id: nextEventId(),
          type: "runtime-request.updated",
          threadId: id,
          runId,
          occurredAt: at(entry.minutesAgo),
          payload: {
            id: requestId,
            nodeId: rootNodeId,
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            // Message mode needs no provider session: Send or Skip works against this server alone.
            responseCapability: { type: "message" },
            createdAt: at(entry.minutesAgo),
            resolvedAt: null,
          },
        });
        pushItem(
          {
            ...base(`question-${key}`, entry.minutesAgo),
            status: "waiting",
            completedAt: null,
            type: "user_input_request",
            requestId,
            questions: entry.questions.map((question) => ({
              ...question,
              options: [...question.options],
            })),
            responseMode: "message",
          },
          entry.minutesAgo,
        );
        break;
      }
    }
  });
  if (!liveMode) return events;
  return events.flatMap((event): OrchestrationV2DomainEvent[] => {
    const inLiveRun = event.runId !== undefined && liveRunIds.has(event.runId);
    if (!inLiveRun) return [];
    if (event.type === "run.created") return [{ ...event, type: "run.updated" }];
    if (
      event.type === "node.updated" ||
      event.type === "subagent.updated" ||
      event.type === "runtime-request.updated"
    )
      return [event];
    if (
      event.type === "turn-item.updated" &&
      (event.payload.type === "subagent" || event.payload.type === "user_input_request")
    )
      return [event];
    return [];
  });
}

const liveOnly = process.argv.includes("--live");
const program = Effect.gen(function* () {
  const sink = yield* EventSink.EventSinkV2;
  if (!liveOnly) {
    yield* resetState;
    yield* seedProjects;
  }
  for (const thread of LAB_THREADS) {
    const events = eventsFor(thread, liveOnly);
    if (events.length > 0) yield* sink.write({ events });
  }
  console.log(
    JSON.stringify({ seeded: LAB_THREADS.length, primaryThreadId: threadId(LAB_PRIMARY_THREAD) }),
  );
}).pipe(Effect.provide(Layer.provideMerge(layerSeed, NodeServices.layer)), Effect.scoped);

await Effect.runPromise(program);
