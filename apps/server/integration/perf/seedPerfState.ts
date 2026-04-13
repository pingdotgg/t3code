import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointRef,
  CommandId,
  EventId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ProjectId,
} from "@t3tools/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";

import {
  buildPerfAssistantMessageCountPlan,
  getPerfSeedScenario,
  perfEventId,
  perfMessageIdForThread,
  perfTurnIdForThread,
  type PerfProjectScenario,
  type PerfSeedScenario,
  type PerfSeedScenarioId,
  type PerfSeedThreadScenario,
} from "@t3tools/shared/perf/scenarioCatalog";
import { ServerConfig } from "../../src/config.ts";
import { OrchestrationProjectionPipelineLive } from "../../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionPipeline } from "../../src/orchestration/Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEventStoreLive } from "../../src/persistence/Layers/OrchestrationEventStore.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "../../src/persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../src/persistence/Services/OrchestrationEventStore.ts";
import { ServerSettingsService, ServerSettingsLive } from "../../src/serverSettings.ts";

export interface PerfSeededState {
  readonly scenarioId: PerfSeedScenarioId;
  readonly runParentDir: string;
  readonly baseDir: string;
  readonly workspaceRoot: string;
  readonly snapshot: OrchestrationReadModel;
}

const templateDirPromises = new Map<PerfSeedScenarioId, Promise<string>>();

function runGit(cwd: string, args: ReadonlyArray<string>) {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

async function initializeGitWorkspace(workspaceRoot: string): Promise<void> {
  await mkdir(workspaceRoot, { recursive: true });
  runGit(workspaceRoot, ["init", "--initial-branch=main"]);
  runGit(workspaceRoot, ["config", "user.email", "perf@example.com"]);
  runGit(workspaceRoot, ["config", "user.name", "Perf Fixture"]);
  await writeFile(
    join(workspaceRoot, "README.md"),
    "# Performance Workspace\n\nSeeded fixture state for local perf regression tests.\n",
    "utf8",
  );
  runGit(workspaceRoot, ["add", "."]);
  runGit(workspaceRoot, ["commit", "-m", "Initial perf workspace"]);
}

function plusMs(baseTimeMs: number, offsetMs: number): string {
  return new Date(baseTimeMs + offsetMs).toISOString();
}

function makeCommandId(prefix: string, threadId: string, turnIndex: number): CommandId {
  return CommandId.makeUnsafe(`${prefix}:${threadId}:${turnIndex.toString().padStart(4, "0")}`);
}

function buildProjectEvent(
  project: PerfProjectScenario,
  workspaceRoot: string,
  createdAt: string,
): Omit<OrchestrationEvent, "sequence"> {
  return {
    type: "project.created",
    eventId: EventId.makeUnsafe(`perf-project-created:${String(project.id)}`),
    aggregateKind: "project",
    aggregateId: project.id,
    occurredAt: createdAt,
    commandId: CommandId.makeUnsafe(`perf-project-create:${String(project.id)}`),
    causationEventId: null,
    correlationId: CommandId.makeUnsafe(`perf-project-create:${String(project.id)}`),
    metadata: {},
    payload: {
      projectId: project.id,
      title: project.title,
      workspaceRoot,
      defaultModelSelection: project.defaultModelSelection,
      scripts: [],
      createdAt,
      updatedAt: createdAt,
    },
  };
}

function buildThreadCreatedEvent(
  thread: PerfSeedThreadScenario,
  project: PerfProjectScenario,
  createdAt: string,
): Omit<OrchestrationEvent, "sequence"> {
  return {
    type: "thread.created",
    eventId: EventId.makeUnsafe(`perf-thread-created:${String(thread.id)}`),
    aggregateKind: "thread",
    aggregateId: thread.id,
    occurredAt: createdAt,
    commandId: CommandId.makeUnsafe(`perf-thread-create:${String(thread.id)}`),
    causationEventId: null,
    correlationId: CommandId.makeUnsafe(`perf-thread-create:${String(thread.id)}`),
    metadata: {},
    payload: {
      threadId: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      modelSelection: project.defaultModelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
      updatedAt: createdAt,
    },
  };
}

function buildUserMessageText(thread: PerfSeedThreadScenario, turnIndex: number): string {
  const base = `${thread.title} request ${turnIndex}: review the current workspace state and explain the next change.`;
  if (turnIndex % 11 === 0) {
    return `${base}\n\nFocus on virtualization, batching, and cross-thread navigation latency.`;
  }
  if (turnIndex % 7 === 0) {
    return `${base}\n\nSummarize CPU-sensitive paths and any websocket burst handling concerns.`;
  }
  return base;
}

function buildAssistantMessageText(
  thread: PerfSeedThreadScenario,
  turnIndex: number,
  assistantMessageIndex: number,
  assistantMessageCount: number,
): string {
  const phaseLabel =
    assistantMessageIndex === 1
      ? "Opening"
      : assistantMessageIndex === assistantMessageCount
        ? "Settled"
        : assistantMessageIndex % 5 === 0
          ? "Checkpoint"
          : "Loop";
  const focusTopics = [
    "checked the visible timeline window and sidebar ordering",
    "trimmed redundant projection work before the next render pass",
    "reviewed websocket fan-out and message grouping pressure",
    "verified checkpoint rows stay bounded while hidden threads move",
    "kept the active route stable while background threads kept streaming",
  ];
  const topic = focusTopics[(turnIndex + assistantMessageIndex) % focusTopics.length]!;
  const threadBias =
    thread.category === "heavy"
      ? "The thread is still dense enough to stress virtualization."
      : thread.category === "burst"
        ? "This pass is still carrying live burst pressure."
        : "Background churn is staying active without stealing focus.";

  return `${thread.title} ${phaseLabel.toLowerCase()} ${assistantMessageIndex}/${assistantMessageCount} for turn ${turnIndex}: ${topic}. ${threadBias}`;
}

function buildProposedPlanMarkdown(thread: PerfSeedThreadScenario, turnIndex: number): string {
  return [
    `## ${thread.title} plan ${turnIndex}`,
    "",
    "1. Measure the current thread switch path against a stable local budget.",
    "2. Reduce avoidable render churn in the visible timeline window.",
    "3. Validate websocket burst handling with real runtime events before tightening thresholds.",
  ].join("\n");
}

function buildCheckpointFiles(
  thread: PerfSeedThreadScenario,
  threadOrdinal: number,
  turnIndex: number,
): ReadonlyArray<{
  readonly path: string;
  readonly kind: string;
  readonly additions: number;
  readonly deletions: number;
}> {
  const nestedPathTemplates = [
    ["apps", "web", "src", "components", `thread-${threadOrdinal + 1}`, "TimelineVirtualizer.tsx"],
    ["apps", "web", "src", "components", `thread-${threadOrdinal + 1}`, "ThreadSummaryPane.tsx"],
    ["apps", "web", "src", "hooks", `thread-${threadOrdinal + 1}`, "useThreadViewport.ts"],
    ["apps", "web", "src", "stores", `thread-${threadOrdinal + 1}`, "timelineStore.ts"],
    [
      "apps",
      "server",
      "src",
      "orchestration",
      `thread-${threadOrdinal + 1}`,
      "projectionPipeline.ts",
    ],
    ["apps", "server", "src", "provider", `thread-${threadOrdinal + 1}`, "runtimeBuffer.ts"],
    ["packages", "shared", "src", "perf", `thread-${threadOrdinal + 1}`, "fixtureBuilders.ts"],
    ["packages", "shared", "src", "perf", `thread-${threadOrdinal + 1}`, "scenarioCatalog.ts"],
    ["packages", "contracts", "src", "orchestration", `thread-${threadOrdinal + 1}`, "schemas.ts"],
    ["docs", "perf", `thread-${threadOrdinal + 1}`, "notes", "regression-findings.md"],
    ["scripts", "perf", `thread-${threadOrdinal + 1}`, "capture-profile.ts"],
    ["test", "perf", "fixtures", `thread-${threadOrdinal + 1}`, "workspace-state.json"],
  ] as const;
  const fileCount = thread.category === "heavy" ? 12 + (turnIndex % 7) : 7 + (turnIndex % 4);

  return Array.from({ length: fileCount }, (_, fileIndex) => {
    const template = nestedPathTemplates[fileIndex % nestedPathTemplates.length]!;
    const variant = Math.floor(fileIndex / nestedPathTemplates.length);
    const baseSegments = [...template];
    const fileName = baseSegments.pop()!;
    const variantFileName =
      variant === 0
        ? fileName
        : fileName.replace(/(\.[^.]*)$/, `-${(variant + 1).toString().padStart(2, "0")}$1`);
    const path = [...baseSegments, variantFileName].join("/");
    const kind =
      fileIndex % 9 === 0
        ? "deleted"
        : fileIndex % 5 === 0
          ? "added"
          : fileIndex % 4 === 0
            ? "renamed"
            : "modified";

    return {
      path,
      kind,
      additions: kind === "deleted" ? 0 : 4 + ((turnIndex + fileIndex) % 11),
      deletions: kind === "added" ? 0 : 1 + ((threadOrdinal + fileIndex + turnIndex) % 6),
    };
  });
}

function buildThreadTurnEvents(
  thread: PerfSeedThreadScenario,
  threadOrdinal: number,
  projectStartMs: number,
): ReadonlyArray<Omit<OrchestrationEvent, "sequence">> {
  const events: Array<Omit<OrchestrationEvent, "sequence">> = [];
  const threadStartMs = projectStartMs + threadOrdinal * 60_000;
  const assistantMessageCountPlan = buildPerfAssistantMessageCountPlan(thread);

  for (let turnIndex = 1; turnIndex <= thread.turnCount; turnIndex += 1) {
    const turnId = perfTurnIdForThread(thread, turnIndex);
    const userMessageId = perfMessageIdForThread(thread, "user", turnIndex, 1);
    const assistantMessageCount = assistantMessageCountPlan[turnIndex - 1] ?? 1;
    const turnBaseMs = threadStartMs + turnIndex * 1_000;
    const userOccurredAt = plusMs(turnBaseMs, 0);
    const activityAssistantIndex =
      thread.activityStride !== null && turnIndex % thread.activityStride === 0
        ? Math.max(2, Math.floor(assistantMessageCount * 0.35))
        : null;
    const planAssistantIndex =
      thread.planStride !== null && turnIndex % thread.planStride === 0
        ? Math.max(2, Math.floor(assistantMessageCount * 0.7))
        : null;
    let lastAssistantMessageId = perfMessageIdForThread(
      thread,
      "assistant",
      turnIndex,
      assistantMessageCount,
    );
    let turnEventOffset = 0;
    const nextEventId = (prefix: string) =>
      perfEventId(prefix, thread.id, turnIndex * 100 + turnEventOffset++);

    events.push({
      type: "thread.message-sent",
      eventId: nextEventId("perf-user-message"),
      aggregateKind: "thread",
      aggregateId: thread.id,
      occurredAt: userOccurredAt,
      commandId: makeCommandId("perf-user-message", String(thread.id), turnIndex),
      causationEventId: null,
      correlationId: makeCommandId("perf-turn", String(thread.id), turnIndex),
      metadata: {},
      payload: {
        threadId: thread.id,
        messageId: userMessageId,
        role: "user",
        text: buildUserMessageText(thread, turnIndex),
        attachments: [],
        turnId,
        streaming: false,
        createdAt: userOccurredAt,
        updatedAt: userOccurredAt,
      },
    });

    for (
      let assistantMessageIndex = 1;
      assistantMessageIndex <= assistantMessageCount;
      assistantMessageIndex += 1
    ) {
      const assistantOccurredAt = plusMs(turnBaseMs, 120 + assistantMessageIndex * 40);
      const assistantMessageId = perfMessageIdForThread(
        thread,
        "assistant",
        turnIndex,
        assistantMessageIndex,
      );
      lastAssistantMessageId = assistantMessageId;

      events.push({
        type: "thread.message-sent",
        eventId: nextEventId("perf-assistant-message"),
        aggregateKind: "thread",
        aggregateId: thread.id,
        occurredAt: assistantOccurredAt,
        commandId: makeCommandId("perf-assistant-message", String(thread.id), turnIndex),
        causationEventId: null,
        correlationId: makeCommandId("perf-turn", String(thread.id), turnIndex),
        metadata: {},
        payload: {
          threadId: thread.id,
          messageId: assistantMessageId,
          role: "assistant",
          text: buildAssistantMessageText(
            thread,
            turnIndex,
            assistantMessageIndex,
            assistantMessageCount,
          ),
          attachments: [],
          turnId,
          streaming: false,
          createdAt: assistantOccurredAt,
          updatedAt: assistantOccurredAt,
        },
      });

      if (activityAssistantIndex === assistantMessageIndex) {
        const activityOccurredAt = plusMs(turnBaseMs, 132 + assistantMessageIndex * 40);
        events.push({
          type: "thread.activity-appended",
          eventId: nextEventId("perf-activity"),
          aggregateKind: "thread",
          aggregateId: thread.id,
          occurredAt: activityOccurredAt,
          commandId: makeCommandId("perf-activity", String(thread.id), turnIndex),
          causationEventId: null,
          correlationId: makeCommandId("perf-turn", String(thread.id), turnIndex),
          metadata: {},
          payload: {
            threadId: thread.id,
            activity: {
              id: perfEventId("perf-activity-row", thread.id, turnIndex),
              tone: "tool",
              kind: "tool.completed",
              summary: `Synthetic command batch ${turnIndex}.${assistantMessageIndex}`,
              payload: {
                command: "perf-simulated",
                batch: turnIndex,
                loop: assistantMessageIndex,
                threadCategory: thread.category,
              },
              turnId,
              createdAt: activityOccurredAt,
            },
          },
        });
      }

      if (planAssistantIndex === assistantMessageIndex) {
        const planOccurredAt = plusMs(turnBaseMs, 140 + assistantMessageIndex * 40);
        events.push({
          type: "thread.proposed-plan-upserted",
          eventId: nextEventId("perf-plan"),
          aggregateKind: "thread",
          aggregateId: thread.id,
          occurredAt: planOccurredAt,
          commandId: makeCommandId("perf-plan", String(thread.id), turnIndex),
          causationEventId: null,
          correlationId: makeCommandId("perf-turn", String(thread.id), turnIndex),
          metadata: {},
          payload: {
            threadId: thread.id,
            proposedPlan: {
              id: `perf-plan:${String(thread.id)}:${turnIndex.toString().padStart(4, "0")}`,
              turnId,
              planMarkdown: buildProposedPlanMarkdown(thread, turnIndex),
              implementedAt: null,
              implementationThreadId: null,
              createdAt: planOccurredAt,
              updatedAt: planOccurredAt,
            },
          },
        });
      }
    }

    if (thread.diffStride !== null && turnIndex % thread.diffStride === 0) {
      const diffOccurredAt = plusMs(turnBaseMs, 180 + assistantMessageCount * 40);
      events.push({
        type: "thread.turn-diff-completed",
        eventId: nextEventId("perf-diff"),
        aggregateKind: "thread",
        aggregateId: thread.id,
        occurredAt: diffOccurredAt,
        commandId: makeCommandId("perf-diff", String(thread.id), turnIndex),
        causationEventId: null,
        correlationId: makeCommandId("perf-turn", String(thread.id), turnIndex),
        metadata: {},
        payload: {
          threadId: thread.id,
          turnId,
          checkpointTurnCount: turnIndex,
          checkpointRef: CheckpointRef.makeUnsafe(
            `refs/perf/${String(thread.id)}/${turnIndex.toString().padStart(4, "0")}`,
          ),
          status: "ready",
          files: buildCheckpointFiles(thread, threadOrdinal, turnIndex),
          assistantMessageId: lastAssistantMessageId,
          completedAt: diffOccurredAt,
        },
      });
    }
  }

  return events;
}

function buildScenarioEvents(
  scenario: PerfSeedScenario,
  workspaceRootsByProjectId: ReadonlyMap<ProjectId, string>,
): ReadonlyArray<Omit<OrchestrationEvent, "sequence">> {
  const projectStartMs = Date.parse("2026-03-01T12:00:00.000Z");
  const threadsByProjectId = new Map<ProjectId, PerfSeedThreadScenario[]>();
  for (const thread of scenario.threads) {
    const existing = threadsByProjectId.get(thread.projectId) ?? [];
    existing.push(thread);
    threadsByProjectId.set(thread.projectId, existing);
  }

  let globalThreadOrdinal = 0;
  const events: Array<Omit<OrchestrationEvent, "sequence">> = [];

  for (const [projectOrdinal, project] of scenario.projects.entries()) {
    const projectWorkspaceRoot = workspaceRootsByProjectId.get(project.id);
    if (!projectWorkspaceRoot) {
      throw new Error(`Missing workspace root for perf project '${String(project.id)}'.`);
    }
    const projectBaseMs = projectStartMs + projectOrdinal * 6 * 60_000;
    const projectCreatedAt = plusMs(projectBaseMs, 0);
    const projectThreads = threadsByProjectId.get(project.id) ?? [];
    events.push(buildProjectEvent(project, projectWorkspaceRoot, projectCreatedAt));

    for (const [threadOrdinalWithinProject, thread] of projectThreads.entries()) {
      const threadCreatedAt = plusMs(projectBaseMs, threadOrdinalWithinProject * 45_000 + 50);
      const threadEvents = buildThreadTurnEvents(thread, globalThreadOrdinal, projectBaseMs);
      globalThreadOrdinal += 1;
      events.push(buildThreadCreatedEvent(thread, project, threadCreatedAt), ...threadEvents);
    }
  }

  return events;
}

async function createTemplateDir(scenarioId: PerfSeedScenarioId): Promise<string> {
  const scenario = getPerfSeedScenario(scenarioId);
  const baseDir = await mkdtemp(join(tmpdir(), `t3-perf-template-${scenarioId}-`));
  const primaryProject = scenario.projects[0];
  if (!primaryProject) {
    throw new Error(`Perf scenario '${scenarioId}' has no projects.`);
  }
  const workspaceRoot = join(baseDir, primaryProject.workspaceDirectoryName);
  const workspaceRootsByProjectId = new Map<ProjectId, string>(
    scenario.projects.map((project) => [project.id, join(baseDir, project.workspaceDirectoryName)]),
  );

  await Promise.all(
    scenario.projects.map((project) =>
      initializeGitWorkspace(join(baseDir, project.workspaceDirectoryName)),
    ),
  );

  const seedLayer = Layer.empty.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(ServerSettingsLive),
    Layer.provideMerge(SqlitePersistenceLayerLive),
    Layer.provideMerge(ServerConfig.layerTest(workspaceRoot, baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(seedLayer);

  const snapshot = await runtime.runPromise(
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      yield* serverSettings.updateSettings({
        enableAssistantStreaming: scenario.id === "burst_base",
      });

      for (const event of buildScenarioEvents(scenario, workspaceRootsByProjectId)) {
        const storedEvent = yield* eventStore.append(event);
        yield* projectionPipeline.projectEvent(storedEvent);
      }

      return yield* snapshotQuery.getSnapshot();
    }),
  );

  const manifestPath = join(baseDir, "perf-seed-manifest.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        scenarioId,
        workspaceRoot,
        snapshotSequence: snapshot.snapshotSequence,
        projectCount: snapshot.projects.length,
        threadCount: snapshot.threads.length,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await runtime.dispose();
  return baseDir;
}

async function getTemplateDir(scenarioId: PerfSeedScenarioId): Promise<string> {
  const existing = templateDirPromises.get(scenarioId);
  if (existing) {
    return existing;
  }
  const created = createTemplateDir(scenarioId);
  templateDirPromises.set(scenarioId, created);
  return created;
}

export async function seedPerfState(scenarioId: PerfSeedScenarioId): Promise<PerfSeededState> {
  const scenario = getPerfSeedScenario(scenarioId);
  const templateDir = await getTemplateDir(scenarioId);
  const runParentDir = await mkdtemp(join(tmpdir(), `t3-perf-run-${scenarioId}-`));
  const baseDir = join(runParentDir, "base");
  await cp(templateDir, baseDir, { recursive: true, force: true });
  const primaryProject = scenario.projects[0];
  if (!primaryProject) {
    throw new Error(`Perf scenario '${scenarioId}' has no projects.`);
  }
  const workspaceRoot = join(baseDir, primaryProject.workspaceDirectoryName);

  const snapshotLayer = Layer.empty.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(ServerSettingsLive),
    Layer.provideMerge(SqlitePersistenceLayerLive),
    Layer.provideMerge(ServerConfig.layerTest(workspaceRoot, baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(snapshotLayer);
  const snapshot = await runtime.runPromise(
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      return yield* snapshotQuery.getSnapshot();
    }),
  );
  await runtime.dispose();

  return {
    scenarioId,
    runParentDir,
    baseDir,
    workspaceRoot,
    snapshot,
  };
}
