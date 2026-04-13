import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import {
  type ClientOrchestrationCommand,
  CommandId,
  MessageId,
  type ModelSelection,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationEvent,
  type ProjectId,
  type TerminalEvent,
  ThreadId,
  type ThreadId as ThreadIdType,
  WS_METHODS,
} from "@t3tools/contracts";
import { PERF_CATALOG_IDS } from "@t3tools/shared/perf/scenarioCatalog";
import { afterEach, describe, expect, it } from "vitest";

import {
  type ServerCommandLatencyMeasurement,
  startServerPerfHarness,
  summarizeCommandLatencyMeasurements,
  summarizeRpcLatencySeries,
  type ServerPerfHarness,
  type ServerRpcLatencySeries,
} from "./serverPerfHarness.ts";
import type { PerfLatencySample } from "@t3tools/shared/perf/artifact";

const CONTROL_PLANE_SAMPLE_COUNT = 4;
const GIT_RPC_SAMPLE_COUNT = 6;
const STREAM_THREAD_COUNT = 5;
const SPAM_THREAD_COUNT = 8;
const TERMINAL_SESSION_COUNT = 3;
const TERMINAL_OUTPUT_LINE_COUNT = 260;
const TERMINAL_OUTPUT_SLEEP_SECONDS = 0.04;
const GIT_BRANCH_COUNT = 240;
const GIT_UNTRACKED_FILE_COUNT = 160;
const DEFAULT_WAIT_TIMEOUT_MS = 45_000;

interface SubscriptionCleanup {
  readonly dispose: () => void;
}

interface EventWaiter<TValue, TResult> {
  readonly description: string;
  readonly select: (values: ReadonlyArray<TValue>) => TResult | null;
  readonly resolve: (value: TResult) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

class BufferedEventFeed<TValue> implements SubscriptionCleanup {
  private readonly values: TValue[] = [];
  private readonly waiters = new Set<EventWaiter<TValue, unknown>>();

  push(value: TValue) {
    this.values.push(value);
    for (const waiter of this.waiters) {
      const match = waiter.select(this.values);
      if (match === null) {
        continue;
      }
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(match);
    }
  }

  waitFor<TResult>(
    description: string,
    select: (values: ReadonlyArray<TValue>) => TResult | null,
    timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  ): Promise<TResult> {
    const immediateMatch = select(this.values);
    if (immediateMatch !== null) {
      return Promise.resolve(immediateMatch);
    }

    return new Promise<TResult>((resolve, reject) => {
      const waiter: EventWaiter<TValue, TResult> = {
        description,
        select,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter as EventWaiter<TValue, unknown>);
          reject(new Error(`Timed out waiting for ${description} after ${timeoutMs}ms.`));
        }, timeoutMs),
      };
      this.waiters.add(waiter as EventWaiter<TValue, unknown>);
    });
  }

  waitForEvent(
    description: string,
    predicate: (value: TValue) => boolean,
    timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  ): Promise<TValue> {
    return this.waitFor(description, (values) => values.find(predicate) ?? null, timeoutMs);
  }

  waitForCount(
    description: string,
    predicate: (value: TValue) => boolean,
    count: number,
    timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  ): Promise<ReadonlyArray<TValue>> {
    return this.waitFor(
      description,
      (values) => {
        const matches = values.filter(predicate);
        return matches.length >= count ? matches.slice(0, count) : null;
      },
      timeoutMs,
    );
  }

  waitForDistinct<TKey extends string | number>(
    description: string,
    predicate: (value: TValue) => boolean,
    selectKey: (value: TValue) => TKey,
    count: number,
    timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  ): Promise<ReadonlyArray<TValue>> {
    return this.waitFor(
      description,
      (values) => {
        const distinctMatches = new Map<TKey, TValue>();
        for (const value of values) {
          if (!predicate(value)) {
            continue;
          }
          const key = selectKey(value);
          if (!distinctMatches.has(key)) {
            distinctMatches.set(key, value);
          }
        }
        const matches = [...distinctMatches.values()];
        return matches.length >= count ? matches : null;
      },
      timeoutMs,
    );
  }

  dispose() {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`Buffered feed disposed while waiting for ${waiter.description}.`));
    }
    this.waiters.clear();
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function nowIso(): string {
  return new Date().toISOString();
}

function runGit(cwd: string, args: ReadonlyArray<string>) {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

function makeControlThreadId(label: string): ThreadIdType {
  return ThreadId.makeUnsafe(`perf-control-${label}-${crypto.randomUUID()}`);
}

function makeCommandId(label: string) {
  return CommandId.makeUnsafe(`perf-command:${label}:${crypto.randomUUID()}`);
}

function makeMessageId(label: string) {
  return MessageId.makeUnsafe(`perf-message:${label}:${crypto.randomUUID()}`);
}

async function dispatchCommand(harness: ServerPerfHarness, command: ClientOrchestrationCommand) {
  return await harness.rpc.request((client) =>
    client[ORCHESTRATION_WS_METHODS.dispatchCommand](command),
  );
}

async function measureCommandLatency(input: {
  readonly harness: ServerPerfHarness;
  readonly orchestrationEvents: BufferedEventFeed<OrchestrationEvent>;
  readonly command: ClientOrchestrationCommand;
  readonly expectedEventType: OrchestrationEvent["type"];
  readonly loadProfile: string;
  readonly timeoutMs?: number;
  readonly metadata?: Record<string, unknown>;
}): Promise<ServerCommandLatencyMeasurement> {
  const startedAt = nowIso();
  const startedAtMs = performance.now();
  const result = await dispatchCommand(input.harness, input.command);
  const ackAtMs = performance.now();
  const event = await input.orchestrationEvents.waitForEvent(
    `${input.expectedEventType} for ${input.command.type}`,
    (candidate) =>
      candidate.type === input.expectedEventType &&
      String(candidate.commandId) === String(input.command.commandId),
    input.timeoutMs,
  );
  const eventAtMs = performance.now();

  return {
    commandType: input.command.type,
    loadProfile: input.loadProfile,
    startedAt,
    dispatchToAckMs: ackAtMs - startedAtMs,
    dispatchToEventMs: eventAtMs - startedAtMs,
    ackToEventMs: eventAtMs - ackAtMs,
    resultSequence: result.sequence,
    eventSequence: event.sequence,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

async function createSupportThread(input: {
  readonly harness: ServerPerfHarness;
  readonly orchestrationEvents: BufferedEventFeed<OrchestrationEvent>;
  readonly projectId: ProjectId;
  readonly modelSelection: ModelSelection;
  readonly label: string;
}): Promise<ThreadIdType> {
  const threadId = makeControlThreadId(`load-${input.label}`);
  const command = {
    type: "thread.create",
    commandId: makeCommandId(`load-thread-create-${input.label}`),
    threadId,
    projectId: input.projectId,
    title: `Perf Load ${input.label}`,
    modelSelection: input.modelSelection,
    interactionMode: "default",
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    createdAt: nowIso(),
  } as const satisfies ClientOrchestrationCommand;

  await dispatchCommand(input.harness, command);
  await input.orchestrationEvents.waitForEvent(
    `thread.created for load support thread ${input.label}`,
    (event) => event.type === "thread.created" && event.payload.threadId === threadId,
  );
  return threadId;
}

async function captureCreateArchiveSamples(input: {
  readonly harness: ServerPerfHarness;
  readonly orchestrationEvents: BufferedEventFeed<OrchestrationEvent>;
  readonly loadProfile: string;
  readonly sampleCount: number;
  readonly projectId: ProjectId;
  readonly modelSelection: ModelSelection;
}): Promise<ReadonlyArray<ServerCommandLatencyMeasurement>> {
  const samples: ServerCommandLatencyMeasurement[] = [];

  for (let sampleIndex = 0; sampleIndex < input.sampleCount; sampleIndex += 1) {
    const threadId = makeControlThreadId(`${input.loadProfile}-${sampleIndex + 1}`);
    const createCommand = {
      type: "thread.create",
      commandId: makeCommandId(`thread-create-${input.loadProfile}-${sampleIndex + 1}`),
      threadId,
      projectId: input.projectId,
      title: `Perf ${input.loadProfile} ${sampleIndex + 1}`,
      modelSelection: input.modelSelection,
      interactionMode: "default",
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: nowIso(),
    } as const satisfies ClientOrchestrationCommand;

    samples.push(
      await measureCommandLatency({
        harness: input.harness,
        orchestrationEvents: input.orchestrationEvents,
        command: createCommand,
        expectedEventType: "thread.created",
        loadProfile: input.loadProfile,
        metadata: {
          sampleIndex: sampleIndex + 1,
          threadId,
        },
      }),
    );

    const archiveCommand = {
      type: "thread.archive",
      commandId: makeCommandId(`thread-archive-${input.loadProfile}-${sampleIndex + 1}`),
      threadId,
    } as const satisfies ClientOrchestrationCommand;

    samples.push(
      await measureCommandLatency({
        harness: input.harness,
        orchestrationEvents: input.orchestrationEvents,
        command: archiveCommand,
        expectedEventType: "thread.archived",
        loadProfile: input.loadProfile,
        metadata: {
          sampleIndex: sampleIndex + 1,
          threadId,
        },
      }),
    );
  }

  return samples;
}

async function ensureStreamingThreads(input: {
  readonly harness: ServerPerfHarness;
  readonly orchestrationEvents: BufferedEventFeed<OrchestrationEvent>;
  readonly projectId: ProjectId;
  readonly modelSelection: ModelSelection;
  readonly count: number;
}): Promise<ReadonlyArray<ThreadIdType>> {
  const threadIds: ThreadIdType[] = [
    PERF_CATALOG_IDS.burstBase.burstThreadId,
    PERF_CATALOG_IDS.burstBase.navigationThreadId,
    PERF_CATALOG_IDS.burstBase.fillerThreadId,
  ];

  while (threadIds.length < input.count) {
    threadIds.push(
      await createSupportThread({
        harness: input.harness,
        orchestrationEvents: input.orchestrationEvents,
        projectId: input.projectId,
        modelSelection: input.modelSelection,
        label: `stream-${threadIds.length + 1}`,
      }),
    );
  }

  return threadIds;
}

async function startAssistantStreamingLoad(input: {
  readonly harness: ServerPerfHarness;
  readonly orchestrationEvents: BufferedEventFeed<OrchestrationEvent>;
  readonly threadIds: ReadonlyArray<ThreadIdType>;
  readonly label: string;
}): Promise<void> {
  await Promise.all(
    input.threadIds.map((threadId, index) =>
      dispatchCommand(input.harness, {
        type: "thread.turn.start",
        commandId: makeCommandId(`${input.label}-turn-start-${index + 1}`),
        threadId,
        message: {
          messageId: makeMessageId(`${input.label}-turn-${index + 1}`),
          role: "user",
          text: `Perf load ${input.label} ${index + 1}`,
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: nowIso(),
      } as const satisfies ClientOrchestrationCommand),
    ),
  );

  const threadIds = new Set(input.threadIds.map(String));
  await input.orchestrationEvents.waitForDistinct(
    `assistant streaming output for ${input.label}`,
    (event) =>
      event.type === "thread.message-sent" &&
      event.payload.role === "assistant" &&
      event.payload.streaming &&
      threadIds.has(String(event.payload.threadId)),
    (event) => (event.type === "thread.message-sent" ? String(event.payload.threadId) : ""),
    input.threadIds.length,
  );
}

async function startCreateTurnSpamLoad(input: {
  readonly harness: ServerPerfHarness;
  readonly orchestrationEvents: BufferedEventFeed<OrchestrationEvent>;
  readonly projectId: ProjectId;
  readonly modelSelection: ModelSelection;
  readonly count: number;
  readonly label: string;
}): Promise<{
  readonly threadIds: ReadonlyArray<ThreadIdType>;
  readonly done: Promise<ReadonlyArray<ThreadIdType>>;
}> {
  const threadIds = Array.from({ length: input.count }, (_, index) =>
    makeControlThreadId(`${input.label}-${index + 1}`),
  );
  const threadIdStrings = new Set(threadIds.map(String));

  const done = Promise.all(
    threadIds.map(async (threadId, index) => {
      const createCommand = {
        type: "thread.create",
        commandId: makeCommandId(`${input.label}-create-${index + 1}`),
        threadId,
        projectId: input.projectId,
        title: `Perf Spam ${index + 1}`,
        modelSelection: input.modelSelection,
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: nowIso(),
      } as const satisfies ClientOrchestrationCommand;
      await dispatchCommand(input.harness, createCommand);
      await input.orchestrationEvents.waitForEvent(
        `thread.created for ${input.label}-${index + 1}`,
        (event) => event.type === "thread.created" && event.payload.threadId === threadId,
      );
      await dispatchCommand(input.harness, {
        type: "thread.turn.start",
        commandId: makeCommandId(`${input.label}-turn-start-${index + 1}`),
        threadId,
        message: {
          messageId: makeMessageId(`${input.label}-turn-${index + 1}`),
          role: "user",
          text: `Perf spam ${input.label} ${index + 1}`,
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: nowIso(),
      } as const satisfies ClientOrchestrationCommand);
      return threadId;
    }),
  );

  await input.orchestrationEvents.waitForCount(
    `thread.create spam ${input.label}`,
    (event) =>
      event.type === "thread.created" && threadIdStrings.has(String(event.payload.threadId)),
    Math.min(4, input.count),
  );
  await input.orchestrationEvents.waitForDistinct(
    `assistant spam output ${input.label}`,
    (event) =>
      event.type === "thread.message-sent" &&
      event.payload.role === "assistant" &&
      event.payload.streaming &&
      threadIdStrings.has(String(event.payload.threadId)),
    (event) => (event.type === "thread.message-sent" ? String(event.payload.threadId) : ""),
    Math.min(4, input.count),
  );

  return {
    threadIds,
    done,
  };
}

async function startTerminalLoad(input: {
  readonly harness: ServerPerfHarness;
  readonly terminalEvents: BufferedEventFeed<TerminalEvent>;
  readonly workspaceRoot: string;
  readonly threadIds: ReadonlyArray<ThreadIdType>;
}): Promise<ReadonlyArray<{ readonly threadId: ThreadIdType; readonly terminalId: string }>> {
  const sessions = await Promise.all(
    input.threadIds.slice(0, TERMINAL_SESSION_COUNT).map(async (threadId, index) => {
      const terminalId = `perf-${index + 1}`;
      await input.harness.rpc.request((client) =>
        client[WS_METHODS.terminalOpen]({
          threadId,
          terminalId,
          cwd: input.workspaceRoot,
          cols: 120,
          rows: 32,
        }),
      );

      const command = [
        "i=1",
        `while [ $i -le ${TERMINAL_OUTPUT_LINE_COUNT} ]`,
        "do",
        `  printf 'perf-terminal-${index + 1}-%03d\\n' "$i"`,
        "  i=$((i + 1))",
        `  sleep ${TERMINAL_OUTPUT_SLEEP_SECONDS.toFixed(2)}`,
        "done",
        "",
      ].join("\n");

      await input.harness.rpc.request((client) =>
        client[WS_METHODS.terminalWrite]({
          threadId,
          terminalId,
          data: command,
        }),
      );

      return {
        threadId,
        terminalId,
      };
    }),
  );

  const terminalIds = new Set(sessions.map((session) => session.terminalId));
  await input.terminalEvents.waitForDistinct(
    "terminal output load",
    (event) => event.type === "output" && terminalIds.has(event.terminalId),
    (event) => event.terminalId,
    sessions.length,
    30_000,
  );

  return sessions;
}

async function closeTerminalLoad(
  harness: ServerPerfHarness,
  sessions: ReadonlyArray<{ readonly threadId: ThreadIdType; readonly terminalId: string }>,
): Promise<void> {
  await Promise.all(
    sessions.map((session) =>
      harness.rpc.request((client) =>
        client[WS_METHODS.terminalClose]({
          threadId: session.threadId,
          terminalId: session.terminalId,
          deleteHistory: true,
        }),
      ),
    ),
  );
}

async function seedGitPressure(workspaceRoot: string): Promise<void> {
  const untrackedDir = join(workspaceRoot, "perf-git-pressure");
  await mkdir(untrackedDir, { recursive: true });
  await Promise.all(
    Array.from({ length: GIT_UNTRACKED_FILE_COUNT }, (_, index) =>
      writeFile(
        join(untrackedDir, `untracked-${(index + 1).toString().padStart(3, "0")}.ts`),
        `export const perfFile${index + 1} = ${index + 1};\n`,
        "utf8",
      ),
    ),
  );

  for (let index = 0; index < GIT_BRANCH_COUNT; index += 1) {
    runGit(workspaceRoot, ["branch", `perf/latency-${(index + 1).toString().padStart(4, "0")}`]);
  }
}

async function measureRpcLatencySeries<TResult>(input: {
  readonly harness: ServerPerfHarness;
  readonly name: string;
  readonly loadProfile: string;
  readonly iterations: number;
  readonly execute: () => Promise<TResult>;
}): Promise<ServerRpcLatencySeries> {
  const samples: PerfLatencySample[] = [];

  for (let iteration = 0; iteration < input.iterations; iteration += 1) {
    const startedAt = nowIso();
    const startedAtMs = performance.now();
    await input.execute();
    const endedAtMs = performance.now();
    samples.push({
      name: `${input.name}-${iteration + 1}`,
      durationMs: endedAtMs - startedAtMs,
      startedAt,
      endedAt: nowIso(),
      metadata: {
        iteration: iteration + 1,
        loadProfile: input.loadProfile,
      },
    });
  }

  return {
    name: input.name,
    loadProfile: input.loadProfile,
    summary: summarizeRpcLatencySeries(samples),
    samples,
  };
}

function groupCommandSeries(
  samples: ReadonlyArray<ServerCommandLatencyMeasurement>,
  loadProfile: string,
) {
  const createSamples = samples.filter((sample) => sample.commandType === "thread.create");
  const archiveSamples = samples.filter((sample) => sample.commandType === "thread.archive");

  return [
    {
      name: "thread.create",
      loadProfile,
      summary: summarizeCommandLatencyMeasurements(createSamples),
      samples: createSamples,
    },
    {
      name: "thread.archive",
      loadProfile,
      summary: summarizeCommandLatencyMeasurements(archiveSamples),
      samples: archiveSamples,
    },
  ] as const;
}

describe("server perf latency", () => {
  const disposables: Array<SubscriptionCleanup> = [];

  afterEach(() => {
    for (const disposable of disposables.splice(0)) {
      disposable.dispose();
    }
  });

  it("records idle and assistant-stream command latency at the websocket boundary", async () => {
    let harness: ServerPerfHarness | null = null;

    try {
      harness = await startServerPerfHarness({
        suite: "server-latency-critical-commands",
        seedScenarioId: "burst_base",
        providerScenarioId: "parallel_assistant_stream",
      });
      const runStartedAt = nowIso();

      const burstProject = harness.seededState.snapshot.projects.find(
        (project) => project.id === PERF_CATALOG_IDS.burstBase.burstProjectId,
      );
      expect(burstProject).toBeTruthy();
      const modelSelection = burstProject!.defaultModelSelection;
      expect(modelSelection).toBeTruthy();

      const orchestrationEvents = new BufferedEventFeed<OrchestrationEvent>();
      disposables.push(orchestrationEvents);
      disposables.push({
        dispose: harness.rpc.subscribe(
          (client) => client[WS_METHODS.subscribeOrchestrationDomainEvents]({}),
          (event) => orchestrationEvents.push(event),
        ),
      });

      await sleep(250);

      const idleSamples = await captureCreateArchiveSamples({
        harness,
        orchestrationEvents,
        loadProfile: "idle",
        sampleCount: CONTROL_PLANE_SAMPLE_COUNT,
        projectId: burstProject!.id,
        modelSelection: modelSelection!,
      });

      const streamingThreadIds = await ensureStreamingThreads({
        harness,
        orchestrationEvents,
        projectId: burstProject!.id,
        modelSelection: modelSelection!,
        count: STREAM_THREAD_COUNT,
      });
      await startAssistantStreamingLoad({
        harness,
        orchestrationEvents,
        threadIds: streamingThreadIds,
        label: "stream-control-plane",
      });

      const streamingSamples = await captureCreateArchiveSamples({
        harness,
        orchestrationEvents,
        loadProfile: "assistant-stream-5x",
        sampleCount: CONTROL_PLANE_SAMPLE_COUNT,
        projectId: burstProject!.id,
        modelSelection: modelSelection!,
      });
      const spamLoad = await startCreateTurnSpamLoad({
        harness,
        orchestrationEvents,
        projectId: burstProject!.id,
        modelSelection: modelSelection!,
        count: SPAM_THREAD_COUNT,
        label: "create-turn-spam-8x",
      });
      const spamSamples = await captureCreateArchiveSamples({
        harness,
        orchestrationEvents,
        loadProfile: "create-turn-spam-8x",
        sampleCount: CONTROL_PLANE_SAMPLE_COUNT,
        projectId: burstProject!.id,
        modelSelection: modelSelection!,
      });
      await spamLoad.done;

      const commandLatency = [
        ...groupCommandSeries(idleSamples, "idle"),
        ...groupCommandSeries(streamingSamples, "assistant-stream-5x"),
        ...groupCommandSeries(spamSamples, "create-turn-spam-8x"),
      ];
      const result = await harness.finishRun({
        artifactBasename: "control-plane-stream-baseline",
        artifact: {
          suite: "server-latency-critical-commands",
          scenarioId: "burst_base_control_plane_stream_baseline",
          startedAt: runStartedAt,
          completedAt: nowIso(),
          commandLatency,
          rpcLatency: [],
          metadata: {
            sampleCountPerProfile: CONTROL_PLANE_SAMPLE_COUNT,
            streamingThreadCount: STREAM_THREAD_COUNT,
            spamThreadCount: SPAM_THREAD_COUNT,
          },
        },
      });
      harness = null;

      expect(result.artifact.commandLatency).toHaveLength(6);
      for (const series of result.artifact.commandLatency) {
        expect(series.samples).toHaveLength(CONTROL_PLANE_SAMPLE_COUNT);
        expect(series.summary.dispatchToEventMs.p50Ms).not.toBeNull();
        expect(series.summary.dispatchToEventMs.maxMs).toBeLessThan(30_000);
      }
    } finally {
      await harness?.dispose();
    }
  }, 180_000);

  it("records command and git rpc latency under terminal and mixed server load", async () => {
    let harness: ServerPerfHarness | null = null;
    let terminalSessions: ReadonlyArray<{
      readonly threadId: ThreadIdType;
      readonly terminalId: string;
    }> = [];

    try {
      harness = await startServerPerfHarness({
        suite: "server-latency-critical-commands",
        seedScenarioId: "burst_base",
        providerScenarioId: "parallel_assistant_stream",
      });
      const runStartedAt = nowIso();

      const burstProject = harness.seededState.snapshot.projects.find(
        (project) => project.id === PERF_CATALOG_IDS.burstBase.burstProjectId,
      );
      expect(burstProject).toBeTruthy();
      const modelSelection = burstProject!.defaultModelSelection;
      expect(modelSelection).toBeTruthy();

      const orchestrationEvents = new BufferedEventFeed<OrchestrationEvent>();
      const terminalEvents = new BufferedEventFeed<TerminalEvent>();
      disposables.push(orchestrationEvents, terminalEvents);
      disposables.push({
        dispose: harness.rpc.subscribe(
          (client) => client[WS_METHODS.subscribeOrchestrationDomainEvents]({}),
          (event) => orchestrationEvents.push(event),
        ),
      });
      disposables.push({
        dispose: harness.rpc.subscribe(
          (client) => client[WS_METHODS.subscribeTerminalEvents]({}),
          (event) => terminalEvents.push(event),
        ),
      });

      await sleep(250);
      await seedGitPressure(harness.seededState.workspaceRoot);

      const gitLatencyIdle = await Promise.all([
        measureRpcLatencySeries({
          harness,
          name: "git.status",
          loadProfile: "idle-repo-pressure",
          iterations: GIT_RPC_SAMPLE_COUNT,
          execute: () =>
            harness!.rpc.request((client) =>
              client[WS_METHODS.gitStatus]({
                cwd: harness!.seededState.workspaceRoot,
              }),
            ),
        }),
        measureRpcLatencySeries({
          harness,
          name: "git.listBranches",
          loadProfile: "idle-repo-pressure",
          iterations: GIT_RPC_SAMPLE_COUNT,
          execute: () =>
            harness!.rpc.request((client) =>
              client[WS_METHODS.gitListBranches]({
                cwd: harness!.seededState.workspaceRoot,
              }),
            ),
        }),
      ]);

      const streamingThreadIds = await ensureStreamingThreads({
        harness,
        orchestrationEvents,
        projectId: burstProject!.id,
        modelSelection: modelSelection!,
        count: STREAM_THREAD_COUNT,
      });

      terminalSessions = await startTerminalLoad({
        harness,
        terminalEvents,
        workspaceRoot: harness.seededState.workspaceRoot,
        threadIds: streamingThreadIds,
      });

      const terminalSamples = await captureCreateArchiveSamples({
        harness,
        orchestrationEvents,
        loadProfile: "terminal-output-3x",
        sampleCount: CONTROL_PLANE_SAMPLE_COUNT,
        projectId: burstProject!.id,
        modelSelection: modelSelection!,
      });

      await sleep(6_500);
      await startAssistantStreamingLoad({
        harness,
        orchestrationEvents,
        threadIds: streamingThreadIds,
        label: "mixed-load",
      });
      await terminalEvents.waitForCount(
        "continued terminal output during mixed load",
        (event) =>
          event.type === "output" &&
          terminalSessions.some((session) => session.terminalId === event.terminalId),
        TERMINAL_SESSION_COUNT,
        30_000,
      );

      const mixedSamples = await captureCreateArchiveSamples({
        harness,
        orchestrationEvents,
        loadProfile: "mixed-stream-terminal-git",
        sampleCount: CONTROL_PLANE_SAMPLE_COUNT,
        projectId: burstProject!.id,
        modelSelection: modelSelection!,
      });

      const gitLatencyMixed = await Promise.all([
        measureRpcLatencySeries({
          harness,
          name: "git.status",
          loadProfile: "mixed-stream-terminal-git",
          iterations: GIT_RPC_SAMPLE_COUNT,
          execute: () =>
            harness!.rpc.request((client) =>
              client[WS_METHODS.gitStatus]({
                cwd: harness!.seededState.workspaceRoot,
              }),
            ),
        }),
        measureRpcLatencySeries({
          harness,
          name: "git.listBranches",
          loadProfile: "mixed-stream-terminal-git",
          iterations: GIT_RPC_SAMPLE_COUNT,
          execute: () =>
            harness!.rpc.request((client) =>
              client[WS_METHODS.gitListBranches]({
                cwd: harness!.seededState.workspaceRoot,
              }),
            ),
        }),
      ]);

      await closeTerminalLoad(harness, terminalSessions);
      terminalSessions = [];

      const result = await harness.finishRun({
        artifactBasename: "terminal-mixed-git-baseline",
        artifact: {
          suite: "server-latency-critical-commands",
          scenarioId: "burst_base_terminal_mixed_git_baseline",
          startedAt: runStartedAt,
          completedAt: nowIso(),
          commandLatency: [
            ...groupCommandSeries(terminalSamples, "terminal-output-3x"),
            ...groupCommandSeries(mixedSamples, "mixed-stream-terminal-git"),
          ],
          rpcLatency: [...gitLatencyIdle, ...gitLatencyMixed],
          metadata: {
            sampleCountPerProfile: CONTROL_PLANE_SAMPLE_COUNT,
            gitRpcSampleCount: GIT_RPC_SAMPLE_COUNT,
            branchCount: GIT_BRANCH_COUNT,
            untrackedFileCount: GIT_UNTRACKED_FILE_COUNT,
            terminalSessionCount: TERMINAL_SESSION_COUNT,
          },
        },
      });
      harness = null;

      expect(result.artifact.commandLatency).toHaveLength(4);
      expect(result.artifact.rpcLatency).toHaveLength(4);
      for (const series of result.artifact.commandLatency) {
        expect(series.samples).toHaveLength(CONTROL_PLANE_SAMPLE_COUNT);
        expect(series.summary.dispatchToEventMs.maxMs).toBeLessThan(30_000);
      }
      for (const series of result.artifact.rpcLatency) {
        expect(series.samples).toHaveLength(GIT_RPC_SAMPLE_COUNT);
        expect(series.summary.maxMs).toBeLessThan(30_000);
      }
    } finally {
      if (harness && terminalSessions.length > 0) {
        await closeTerminalLoad(harness, terminalSessions).catch(() => undefined);
      }
      await harness?.dispose();
    }
  }, 180_000);
});
