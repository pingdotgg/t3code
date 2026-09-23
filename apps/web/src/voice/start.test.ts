import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadDetailSnapshot,
  type OrchestrationV2ThreadLaunchInput,
  type OrchestrationV2ThreadLaunchResult,
  type OrchestrationV2ThreadProjection,
  type VoiceRequestId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createVoiceToolExecutor,
  deriveVoiceRequestIdentifiers,
  VoiceToolFailureError,
  type VoiceEnvironmentAccess,
  type VoiceEnvironmentCatalogEntry,
  type VoiceToolHost,
} from "./tools";
import toolsSource from "./tools.ts?raw";

const envA = EnvironmentId.make("env-a");
const projectA = ProjectId.make("project-a");
const runA = RunId.make("run-a");

const modelSelection = { instanceId: "inst-a", model: "model-a" } as ModelSelection;
const now = DateTime.makeUnsafe("2026-09-02T10:00:00.000Z");
const providerInstanceId = ProviderInstanceId.make("inst-a");

const baseInput = {
  requestId: "voice-request-t5-1" as VoiceRequestId,
  environmentId: envA,
  projectId: projectA,
  task: "Investigate the flaky deploy",
  modelSelection,
};

type MessageDispatchCommand = Extract<OrchestrationV2Command, { type: "message.dispatch" }>;

describe("existing-thread follow-ups", () => {
  it("does not dispatch when the existing thread's provider is unavailable", async () => {
    const { executor, access } = executorWith({
      serverConfig: async () => ({
        providers: [serverProvider({ instanceId: "inst-a", enabled: false })],
        settings: {},
      }),
    });
    await expect(
      executor.continueThread({
        requestId: baseInput.requestId,
        environmentId: envA,
        threadId: ThreadId.make("existing-plan"),
        task: "Give me an update",
      }),
    ).rejects.toBeDefined();
    expect(access.dispatchCommand).not.toHaveBeenCalled();
  });

  it("sends the update to the existing thread without creating or renaming it, and deduplicates replay", async () => {
    const { executor, access } = executorWith();
    const input = {
      requestId: baseInput.requestId,
      environmentId: envA,
      threadId: ThreadId.make("existing-plan"),
      task: "Please give me an update",
    };
    const first = await executor.continueThread(input);
    expect(first.threadId).toBe(input.threadId);
    expect(await executor.continueThread(input)).toEqual(first);
    expect(access.dispatchCommand).toHaveBeenCalledOnce();
    const command = dispatchedMessageDispatch(access);
    expect(command.threadId).toBe(input.threadId);
    expect(command.text).toBe(input.task);
    expect(command.titleSeed).toBeUndefined();
    expect(command.modelSelection).toBeUndefined();
    await expect(
      executor.continueThread({ ...input, threadId: ThreadId.make("other") }),
    ).rejects.toThrow();
  });

  it("never dispatches a follow-up to a missing thread", async () => {
    const { executor, access } = executorWith({
      threadSnapshot: vi.fn(async () => {
        throw { _tag: "EnvironmentResourceNotFoundError", message: "thread not found" };
      }),
    });
    await expect(
      executor.continueThread({
        requestId: baseInput.requestId,
        environmentId: envA,
        threadId: ThreadId.make("missing-plan"),
        task: "Please give me an update",
      }),
    ).rejects.toBeDefined();
    expect(access.dispatchCommand).not.toHaveBeenCalled();
  });

  it("reports an accepted follow-up as starting instead of echoing the stale pre-dispatch run state", async () => {
    // The incident: after a server restart the previous run's terminal state
    // (including its error) is what the post-dispatch read-back still showed,
    // so the follow-up was narrated as a dead worker while the work was in
    // fact running.
    const staleProjection = projectionWithRuns([
      runFixture({ status: "failed", completedAt: now }),
    ]);
    (staleProjection as unknown as { turnItems: unknown[] }).turnItems = [
      errorTurnItem("Provider session did not survive a server restart."),
    ];
    const threadSnapshot = vi.fn(async () => detailSnapshot(staleProjection));
    const { executor, access } = executorWith({ threadSnapshot });
    const output = await executor.continueThread({
      requestId: baseInput.requestId,
      environmentId: envA,
      threadId: ThreadId.make("existing-plan"),
      task: "Please give me an update",
    });
    // The dispatch receipt still proves acceptance and the run identity.
    expect(access.dispatchCommand as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
    expect(output.dispatchSequence).toBe(42);
    expect(output.commandId).toBeTruthy();
    expect(output.messageId).toBeTruthy();
    // The stale terminal status and its inherited error are not reported as
    // this follow-up's outcome; the honest in-flight state is.
    expect(output.run).toEqual({ status: "starting", lastError: null });
  });

  it("reports a genuine post-dispatch run advance as observed, including a new error", async () => {
    const staleProjection = projectionWithRuns([
      runFixture({ status: "failed", completedAt: now }),
    ]);
    (staleProjection as unknown as { turnItems: unknown[] }).turnItems = [
      errorTurnItem("Provider session did not survive a server restart."),
    ];
    const advancedProjection = projectionWithRuns([
      runFixture({ status: "failed", completedAt: now }),
      runFixture({ id: RunId.make("run-b"), ordinal: 2, status: "failed", completedAt: now }),
    ]);
    (advancedProjection as unknown as { turnItems: unknown[] }).turnItems = [
      errorTurnItem("provider turn.start failed: model unavailable", RunId.make("run-b")),
    ];
    const threadSnapshot = vi
      .fn()
      .mockImplementationOnce(async () => detailSnapshot(staleProjection))
      .mockImplementationOnce(async () => detailSnapshot(advancedProjection));
    const { executor } = executorWith({ threadSnapshot });
    const output = await executor.continueThread({
      requestId: baseInput.requestId,
      environmentId: envA,
      threadId: ThreadId.make("existing-plan"),
      task: "Please give me an update",
    });
    expect(output.run).toEqual({
      status: "failed",
      lastError: "provider turn.start failed: model unavailable",
    });
  });

  it("reports a new run that repeats the previous failure as observed, not starting", async () => {
    const error = "provider turn.start failed: model unavailable";
    const staleProjection = projectionWithRuns([
      runFixture({ status: "failed", completedAt: now }),
    ]);
    (staleProjection as unknown as { turnItems: unknown[] }).turnItems = [errorTurnItem(error)];
    const repeatedProjection = projectionWithRuns([
      runFixture({ status: "failed", completedAt: now }),
      runFixture({ id: RunId.make("run-b"), ordinal: 2, status: "failed", completedAt: now }),
    ]);
    (repeatedProjection as unknown as { turnItems: unknown[] }).turnItems = [
      errorTurnItem(error),
      errorTurnItem(error, RunId.make("run-b")),
    ];
    const threadSnapshot = vi
      .fn()
      .mockImplementationOnce(async () => detailSnapshot(staleProjection))
      .mockImplementationOnce(async () => detailSnapshot(repeatedProjection));
    const { executor } = executorWith({ threadSnapshot });
    const output = await executor.continueThread({
      requestId: baseInput.requestId,
      environmentId: envA,
      threadId: ThreadId.make("existing-plan"),
      task: "Please give me an update",
    });
    expect(output.run).toEqual({ status: "failed", lastError: error });
  });

  it("reports a steered run that completed before readback as completed", async () => {
    const activeProjection = projectionWithRuns([runFixture({ status: "running" })]);
    const completedProjection = projectionWithRuns([
      runFixture({ status: "completed", completedAt: now }),
    ]);
    const threadSnapshot = vi
      .fn()
      .mockImplementationOnce(async () => detailSnapshot(activeProjection))
      .mockImplementationOnce(async () => detailSnapshot(completedProjection));
    const { executor } = executorWith({ threadSnapshot });
    const output = await executor.continueThread({
      requestId: baseInput.requestId,
      environmentId: envA,
      threadId: ThreadId.make("existing-plan"),
      task: "Please give me an update",
    });
    expect(output.run).toEqual({ status: "completed", lastError: null });
  });

  it("reports a follow-up that advanced the run to running as running", async () => {
    const staleProjection = projectionWithRuns([
      runFixture({ status: "failed", completedAt: now }),
    ]);
    (staleProjection as unknown as { turnItems: unknown[] }).turnItems = [
      errorTurnItem("Provider session did not survive a server restart."),
    ];
    const runningProjection = projectionWithRuns([
      runFixture({ status: "failed", completedAt: now }),
      runFixture({ id: RunId.make("run-b"), ordinal: 2, status: "running" }),
    ]);
    const threadSnapshot = vi
      .fn()
      .mockImplementationOnce(async () => detailSnapshot(staleProjection))
      .mockImplementationOnce(async () => detailSnapshot(runningProjection));
    const { executor } = executorWith({ threadSnapshot });
    const output = await executor.continueThread({
      requestId: baseInput.requestId,
      environmentId: envA,
      threadId: ThreadId.make("existing-plan"),
      task: "Please give me an update",
    });
    expect(output.run).toEqual({ status: "running", lastError: null });
  });

  it("reports an unchanged live running run as observed", async () => {
    // A worker genuinely running across the dispatch stays running; the
    // follow-up is delivered to a live thread.
    const { executor } = executorWith();
    const output = await executor.continueThread({
      requestId: baseInput.requestId,
      environmentId: envA,
      threadId: ThreadId.make("existing-plan"),
      task: "Please give me an update",
    });
    expect(output.run).toEqual({ status: "running", lastError: null });
  });

  it("resolves delivery through the server when it resolves command context", async () => {
    const { executor, access } = executorWith();
    await executor.continueThread({
      requestId: baseInput.requestId,
      environmentId: envA,
      threadId: ThreadId.make("existing-plan"),
      task: "Please give me an update",
    });
    const command = dispatchedMessageDispatch(access);
    expect(command.dispatchMode).toEqual({ type: "start_immediately" });
    expect(command.deliveryIntent).toBe("auto");
  });

  it("queues behind the active run when the server does not resolve command context", async () => {
    const { executor, access } = executorWith({
      serverConfig: async () => ({
        providers: providersFixture(),
        settings: { newWorktreesStartFromOrigin: true },
        environment: { capabilities: {} },
      }),
    });
    await executor.continueThread({
      requestId: baseInput.requestId,
      environmentId: envA,
      threadId: ThreadId.make("existing-plan"),
      task: "Please give me an update",
    });
    const command = dispatchedMessageDispatch(access);
    expect(command.dispatchMode).toEqual({ type: "queue_after_active" });
    expect(command.deliveryIntent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface ServerProviderFixture {
  instanceId: string;
  driver: string;
  enabled: boolean;
  installed: boolean;
  version: string;
  status: string;
  auth: { status: string };
  checkedAt: string;
  models: Array<{ slug: string; name: string; isCustom: boolean; capabilities: null }>;
  slashCommands: never[];
  skills: never[];
  availability?: "available" | "unavailable";
  unavailableReason?: string;
}

function serverProvider(
  overrides: { instanceId: string } & Omit<Partial<ServerProviderFixture>, "instanceId">,
): ServerProviderFixture {
  const { instanceId, ...rest } = overrides;
  return {
    driver: "claude",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-02T10:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    instanceId,
    ...rest,
  };
}

function providersFixture(): ServerProviderFixture[] {
  return [
    serverProvider({
      instanceId: "inst-a",
      models: [
        { slug: "model-a", name: "Model A", isCustom: false, capabilities: null },
        { slug: "model-b", name: "Model B", isCustom: false, capabilities: null },
      ],
    }),
  ];
}

interface ShellProjectFixture {
  id: ProjectId;
  title: string;
  workspaceRoot: string;
  repositoryIdentity: null;
  defaultModelSelection: null;
  scripts: never[];
  createdAt: DateTime.Utc;
  updatedAt: DateTime.Utc;
  defaultThreadEnvMode?: "local" | "worktree" | null;
}

function projectShell(overrides: {
  id: ProjectId;
  defaultThreadEnvMode?: "local" | "worktree" | null;
  workspaceRoot?: string;
}): ShellProjectFixture {
  return {
    id: overrides.id,
    title: "Oracle",
    workspaceRoot: overrides.workspaceRoot ?? "/tmp/oracle",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
    ...(overrides.defaultThreadEnvMode !== undefined
      ? { defaultThreadEnvMode: overrides.defaultThreadEnvMode }
      : {}),
  };
}

function shellSnapshotFixture(projects: ShellProjectFixture[]): {
  schemaVersion: number;
  snapshotSequence: number;
  projects: ShellProjectFixture[];
  threads: never[];
  archivedThreads: never[];
} {
  return {
    schemaVersion: 1,
    snapshotSequence: 7,
    projects,
    threads: [],
    archivedThreads: [],
  };
}

function projectionWithRuns(
  runs: OrchestrationV2ThreadProjection["runs"],
): OrchestrationV2ThreadProjection {
  return projection({ runs });
}

function projection(
  overrides: Partial<OrchestrationV2ThreadProjection> & {
    id?: string;
    modelSelection?: ModelSelection | null;
  } = {},
): OrchestrationV2ThreadProjection {
  const threadId = overrides.id ?? "existing-plan";
  return {
    thread: {
      id: ThreadId.make(threadId),
      projectId: projectA,
      title: "Thread",
      providerInstanceId,
      modelSelection: overrides.modelSelection ?? modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        rootThreadId: ThreadId.make(threadId),
        parentThreadId: null,
        relationshipToParent: null,
      },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: now,
    ...overrides,
  };
}

function runFixture(
  overrides: Partial<OrchestrationV2ThreadProjection["runs"][number]> & { id?: RunId },
): OrchestrationV2ThreadProjection["runs"][number] {
  return {
    id: overrides.id ?? runA,
    threadId: ThreadId.make("existing-plan"),
    ordinal: 1,
    providerInstanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make("msg-1"),
    rootNodeId: null,
    activeAttemptId: null,
    status: "running",
    requestedAt: now,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
    ...overrides,
  };
}

function errorTurnItem(
  message: string,
  errorRunId: RunId = runA,
): OrchestrationV2ThreadProjection["turnItems"][number] {
  return {
    type: "error",
    id: "item-1" as never,
    threadId: ThreadId.make("existing-plan"),
    runId: errorRunId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "failed",
    title: null,
    startedAt: null,
    completedAt: now,
    updatedAt: now,
    failure: {
      class: "provider_error",
      message,
      code: null,
      retryable: null,
    },
  } as never;
}

function detailSnapshot(
  threadProjection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadDetailSnapshot {
  return { snapshotSequence: 11, projection: threadProjection };
}

function catalogEntry(overrides: { environmentId: EnvironmentId }): VoiceEnvironmentCatalogEntry {
  return {
    environmentId: overrides.environmentId,
    label: overrides.environmentId,
    connectionState: "connected",
    isPrimary: false,
    voiceLiveCapable: false,
    scopes: ["orchestration:read", "orchestration:operate"],
  };
}

interface VcsRefFixture {
  name: string;
  current: boolean;
  isDefault: boolean;
  worktreePath: null;
  isRemote?: boolean;
}

function ref(name: string, flags: { current: boolean; isDefault: boolean }): VcsRefFixture {
  return { name, current: flags.current, isDefault: flags.isDefault, worktreePath: null };
}

function refsResult(refs: VcsRefFixture[]): {
  refs: VcsRefFixture[];
  isRepo: boolean;
  hasPrimaryRemote: boolean;
  nextCursor: null;
  totalCount: number;
} {
  return { refs, isRepo: true, hasPrimaryRemote: false, nextCursor: null, totalCount: refs.length };
}

interface StartAccessOverrides {
  readonly serverConfig?: () => Promise<unknown>;
  readonly shellSnapshot?: () => Promise<unknown>;
  readonly threadSnapshot?: (threadId?: string) => Promise<unknown>;
  readonly dispatchCommand?: (command: OrchestrationV2Command) => Promise<{ sequence: number }>;
  readonly launchThread?: (
    input: OrchestrationV2ThreadLaunchInput,
  ) => Promise<OrchestrationV2ThreadLaunchResult>;
  readonly listRefs?: (cwd: string) => Promise<unknown>;
}

function accessMock(overrides: StartAccessOverrides = {}): VoiceEnvironmentAccess {
  const launchResult = (): OrchestrationV2ThreadLaunchResult => ({
    threadId: ThreadId.make("existing-plan"),
    projection: projectionWithRuns([runFixture({ status: "running" })]),
    resumed: false,
  });
  return {
    shellSnapshot:
      overrides.shellSnapshot ??
      vi.fn(async () => shellSnapshotFixture([projectShell({ id: projectA })])),
    searchThreads: vi.fn(async () => ({ matches: [] })),
    threadSnapshot:
      overrides.threadSnapshot ??
      vi.fn(async () => detailSnapshot(projectionWithRuns([runFixture({ status: "running" })]))),
    serverConfig:
      overrides.serverConfig ??
      vi.fn(async () => ({
        providers: providersFixture(),
        settings: { newWorktreesStartFromOrigin: true },
        environment: { capabilities: { serverResolvedCommandContext: true } },
      })),
    subscribeThread: vi.fn(async () => ({ kind: "synchronized" })),
    listRefs:
      overrides.listRefs ??
      vi.fn(async () => refsResult([ref("main", { current: true, isDefault: true })])),
    dispatchCommand: overrides.dispatchCommand ?? vi.fn(async () => ({ sequence: 42 })),
    launchThread: overrides.launchThread ?? vi.fn(async () => launchResult()),
  } as unknown as VoiceEnvironmentAccess;
}

function hostMock(input: {
  entries?: VoiceEnvironmentCatalogEntry[];
  access?: VoiceEnvironmentAccess | null;
}): VoiceToolHost & {
  catalogEnvironments: ReturnType<typeof vi.fn>;
  openEnvironment: ReturnType<typeof vi.fn>;
} {
  const access = input.access === undefined ? null : input.access;
  return {
    catalogEnvironments: vi.fn(() => input.entries ?? []),
    openEnvironment: vi.fn(() => access),
  } as unknown as VoiceToolHost & {
    catalogEnvironments: ReturnType<typeof vi.fn>;
    openEnvironment: ReturnType<typeof vi.fn>;
  };
}

function executorWith(overrides: StartAccessOverrides = {}) {
  const access = accessMock(overrides);
  const host = hostMock({ entries: [catalogEntry({ environmentId: envA })], access });
  return { executor: createVoiceToolExecutor(host), access, host };
}

function dispatchedLaunch(
  access: VoiceEnvironmentAccess,
  callIndex = 0,
): OrchestrationV2ThreadLaunchInput {
  const launch = access.launchThread as ReturnType<typeof vi.fn> | undefined;
  const call = launch?.mock.calls[callIndex]?.[0] as OrchestrationV2ThreadLaunchInput | undefined;
  if (call === undefined) {
    throw new Error("expected a launchThread call");
  }
  return call;
}

function dispatchedMessageDispatch(
  access: VoiceEnvironmentAccess,
  callIndex = 0,
): MessageDispatchCommand {
  const dispatch = access.dispatchCommand as ReturnType<typeof vi.fn> | undefined;
  const call = dispatch?.mock.calls[callIndex]?.[0] as OrchestrationV2Command | undefined;
  if (call === undefined || call.type !== "message.dispatch") {
    throw new Error("expected a message.dispatch command");
  }
  return call;
}

async function failureOf(run: () => Promise<unknown>): Promise<VoiceToolFailureError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof VoiceToolFailureError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected the call to reject with VoiceToolFailureError.");
}

// ---------------------------------------------------------------------------
// Deterministic identifier derivation
// ---------------------------------------------------------------------------

describe("deriveVoiceRequestIdentifiers", () => {
  it("derives the same command/thread/message triple from the same request id", async () => {
    const first = await deriveVoiceRequestIdentifiers(baseInput.requestId);
    const second = await deriveVoiceRequestIdentifiers(baseInput.requestId);
    expect(second).toEqual(first);
  });

  it("derives distinct triples for distinct request ids", async () => {
    const first = await deriveVoiceRequestIdentifiers(baseInput.requestId);
    const second = await deriveVoiceRequestIdentifiers("voice-request-t5-2" as VoiceRequestId);
    expect(second.commandId).not.toBe(first.commandId);
    expect(second.threadId).not.toBe(first.threadId);
    expect(second.messageId).not.toBe(first.messageId);
  });

  it("derives distinct UUID-shaped ids per role", async () => {
    const ids = await deriveVoiceRequestIdentifiers(baseInput.requestId);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(ids.commandId).toMatch(uuid);
    expect(ids.threadId).toMatch(uuid);
    expect(ids.messageId).toMatch(uuid);
    expect(new Set([ids.commandId, ids.threadId, ids.messageId]).size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// One-command creation
// ---------------------------------------------------------------------------

describe("startThread creation path", () => {
  it("launches exactly once with the derived ids and reads back the run state", async () => {
    const { executor, access } = executorWith();
    const output = await executor.startThread({ ...baseInput, title: "My title" });
    const launch = access.launchThread as ReturnType<typeof vi.fn>;
    const threadSnapshot = access.threadSnapshot as ReturnType<typeof vi.fn>;

    expect(launch).toHaveBeenCalledTimes(1);
    const input = dispatchedLaunch(access);
    const ids = await deriveVoiceRequestIdentifiers(baseInput.requestId);
    expect(input.commandId).toBe(ids.commandId);
    expect(input.threadId).toBe(ids.threadId);
    expect(input.initialMessage?.messageId).toBe(ids.messageId);
    expect(input.initialMessage?.text).toBe(baseInput.task);
    expect(input.initialMessage?.attachments).toEqual([]);
    expect(input.projectId).toBe(projectA);
    expect(output.commandId).toBe(ids.commandId);
    expect(output.threadId).toBe(ids.threadId);
    expect(output.messageId).toBe(ids.messageId);
    // A launch receipt carries no event sequence; observation resumes from
    // the thread's full replay.
    expect(output.dispatchSequence).toBe(0);
    expect(output.environment).toEqual({ environmentId: envA, status: "ok" });
    expect(output.run).toEqual({ status: "running", lastError: null });
    expect(threadSnapshot).toHaveBeenCalledWith(ids.threadId);
  });

  it("carries the title into the launch and requests generation only when none was given", async () => {
    const { executor, access } = executorWith();
    await executor.startThread({ ...baseInput, title: "My title" });
    const explicit = dispatchedLaunch(access);
    expect(explicit.title).toBe("My title");
    expect(explicit.generateTitle).toBe(false);

    const second = executorWith();
    await second.executor.startThread(baseInput);
    const derived = dispatchedLaunch(second.access);
    expect(derived.title).toBe(baseInput.task);
    expect(derived.generateTitle).toBe(true);
  });

  it("sends the server's own default runtime mode, never a hardcoded literal", async () => {
    const { executor, access } = executorWith();
    await executor.startThread(baseInput);
    const input = dispatchedLaunch(access);
    expect(input.runtimeMode).toBe(DEFAULT_RUNTIME_MODE);
    expect(input.interactionMode).toBe(DEFAULT_PROVIDER_INTERACTION_MODE);
    // No runtime-mode or worktree base literal may appear in the voice
    // creation source; values must come from resolved state, never literals.
    expect(toolsSource).not.toContain('"full-access"');
    expect(toolsSource).not.toContain('"HEAD"');
  });

  it("passes an explicit spoken runtime override through unchanged", async () => {
    const { executor, access } = executorWith();
    await executor.startThread({ ...baseInput, runtimeMode: "auto" });
    const input = dispatchedLaunch(access);
    expect(input.runtimeMode).toBe("auto");
  });

  it("refuses an unknown runtime mode literal before dispatch", async () => {
    const { executor, access } = executorWith();
    const failure = await failureOf(() =>
      executor.startThread({ ...baseInput, runtimeMode: "yolo-mode" }),
    );
    expect(failure.error.code).toBe("invalid_request");
    expect(access.launchThread as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("rejects an empty task before dispatch", async () => {
    const { executor, access } = executorWith();
    const failure = await failureOf(() => executor.startThread({ ...baseInput, task: "   " }));
    expect(failure.error.code).toBe("invalid_request");
    expect(access.launchThread as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("launches in the project root (root workspace strategy) by default", async () => {
    const { executor, access } = executorWith();
    await executor.startThread(baseInput);
    const input = dispatchedLaunch(access);
    expect(input.workspaceStrategy).toEqual({ type: "root" });
    expect(access.listRefs as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("supplies a worktree strategy from the current ref when the project explicitly prefers worktree threads", async () => {
    const { executor, access } = executorWith({
      shellSnapshot: vi.fn(async () =>
        shellSnapshotFixture([
          projectShell({ id: projectA, defaultThreadEnvMode: "worktree", workspaceRoot: "/tmp/o" }),
        ]),
      ),
      listRefs: vi.fn(async () => refsResult([ref("main", { current: true, isDefault: true })])),
    });
    await executor.startThread(baseInput);
    const input = dispatchedLaunch(access);
    const listRefs = access.listRefs as ReturnType<typeof vi.fn>;
    expect(listRefs).toHaveBeenCalledWith("/tmp/o");
    const strategy = input.workspaceStrategy as {
      type: string;
      baseRef: string;
      branch?: string;
    };
    expect(strategy.type).toBe("worktree");
    expect(strategy.baseRef).toBe("main");
    expect(strategy.baseRef).not.toBe("HEAD");
    expect(strategy.branch).toBe(
      `voice-${(await deriveVoiceRequestIdentifiers(baseInput.requestId)).threadId}`,
    );
  });

  it("falls back to the default ref when no current ref exists", async () => {
    const { executor, access } = executorWith({
      shellSnapshot: vi.fn(async () =>
        shellSnapshotFixture([
          projectShell({ id: projectA, defaultThreadEnvMode: "worktree", workspaceRoot: "/tmp/o" }),
        ]),
      ),
      listRefs: vi.fn(async () =>
        refsResult([
          ref("feature-x", { current: false, isDefault: false }),
          ref("develop", { current: false, isDefault: true }),
        ]),
      ),
    });
    await executor.startThread(baseInput);
    const input = dispatchedLaunch(access);
    expect((input.workspaceStrategy as { baseRef: string }).baseRef).toBe("develop");
    expect((input.workspaceStrategy as { baseRef: string }).baseRef).not.toBe("HEAD");
  });

  it("refuses a worktree start when neither a current nor a default ref exists", async () => {
    const { executor, access } = executorWith({
      shellSnapshot: vi.fn(async () =>
        shellSnapshotFixture([
          projectShell({ id: projectA, defaultThreadEnvMode: "worktree", workspaceRoot: "/tmp/o" }),
        ]),
      ),
      listRefs: vi.fn(async () =>
        refsResult([ref("feature-x", { current: false, isDefault: false })]),
      ),
    });
    const failure = await failureOf(() => executor.startThread(baseInput));
    expect(failure.error.code).toBe("invalid_request");
    expect(failure.error.message).toContain(projectA);
    expect(failure.error.projectId).toBe(projectA);
    expect(access.launchThread as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("refuses a worktree start when the boundary cannot list refs", async () => {
    const access = accessMock({
      shellSnapshot: vi.fn(async () =>
        shellSnapshotFixture([
          projectShell({ id: projectA, defaultThreadEnvMode: "worktree", workspaceRoot: "/tmp/o" }),
        ]),
      ),
    });
    const { listRefs: _omitted, ...withoutListRefs } = access as VoiceEnvironmentAccess & {
      listRefs?: unknown;
    };
    void _omitted;
    const host = hostMock({
      entries: [catalogEntry({ environmentId: envA })],
      access: withoutListRefs as VoiceEnvironmentAccess,
    });
    const executor = createVoiceToolExecutor(host);
    const failure = await failureOf(() => executor.startThread(baseInput));
    expect(failure.error.code).toBe("invalid_request");
    expect(failure.error.message).toContain(projectA);
    expect(access.launchThread as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("passes startFromOrigin when the environment's newWorktreesStartFromOrigin setting is true", async () => {
    const { executor, access } = executorWith({
      shellSnapshot: vi.fn(async () =>
        shellSnapshotFixture([
          projectShell({ id: projectA, defaultThreadEnvMode: "worktree", workspaceRoot: "/tmp/o" }),
        ]),
      ),
      serverConfig: vi.fn(async () => ({
        providers: providersFixture(),
        settings: { newWorktreesStartFromOrigin: true },
      })),
      listRefs: vi.fn(async () => refsResult([ref("main", { current: true, isDefault: true })])),
    });
    await executor.startThread(baseInput);
    const input = dispatchedLaunch(access);
    expect((input.workspaceStrategy as { startFromOrigin?: boolean }).startFromOrigin).toBe(true);
  });

  it("omits startFromOrigin when the environment's newWorktreesStartFromOrigin setting is false", async () => {
    const { executor, access } = executorWith({
      shellSnapshot: vi.fn(async () =>
        shellSnapshotFixture([
          projectShell({ id: projectA, defaultThreadEnvMode: "worktree", workspaceRoot: "/tmp/o" }),
        ]),
      ),
      serverConfig: vi.fn(async () => ({
        providers: providersFixture(),
        settings: { newWorktreesStartFromOrigin: false },
      })),
      listRefs: vi.fn(async () => refsResult([ref("main", { current: true, isDefault: true })])),
    });
    await executor.startThread(baseInput);
    const input = dispatchedLaunch(access);
    expect(
      (input.workspaceStrategy as { startFromOrigin?: boolean }).startFromOrigin,
    ).toBeUndefined();
  });

  it("treats a projected local (null env mode) as no worktree preference", async () => {
    const { executor, access } = executorWith({
      shellSnapshot: vi.fn(async () =>
        shellSnapshotFixture([projectShell({ id: projectA, defaultThreadEnvMode: null })]),
      ),
    });
    await executor.startThread(baseInput);
    const input = dispatchedLaunch(access);
    expect(input.workspaceStrategy).toEqual({ type: "root" });
  });

  it("reports a worker that is still running in-band, without waiting for it", async () => {
    const { executor } = executorWith();
    const output = await executor.startThread(baseInput);
    expect(output.run?.status).toBe("running");
    expect(output.run?.lastError).toBeNull();
  });

  it("reports a fast terminal success from the read-back", async () => {
    const completed = projectionWithRuns([runFixture({ status: "completed", completedAt: now })]);
    const { executor, access } = executorWith({
      threadSnapshot: vi.fn(async () => detailSnapshot(completed)),
    });
    const output = await executor.startThread(baseInput);
    expect(output.run?.status).toBe("completed");
    expect(output.run?.lastError).toBeNull();
    expect(access.launchThread as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });

  it("reports a failed run and its error in-band instead of claiming success", async () => {
    const failed = projectionWithRuns([runFixture({ status: "failed", completedAt: now })]);
    (failed as unknown as { turnItems: unknown[] }).turnItems = [errorTurnItem("provider crashed")];
    const { executor } = executorWith({
      threadSnapshot: vi.fn(async () => detailSnapshot(failed)),
    });
    const output = await executor.startThread(baseInput);
    expect(output.run?.status).toBe("failed");
    expect(output.run?.lastError).toBe("provider crashed");
  });

  it("reports an unprojected first run as the honest in-flight starting state", async () => {
    const { executor } = executorWith({
      threadSnapshot: vi.fn(async () => detailSnapshot(projection())),
    });
    const output = await executor.startThread(baseInput);
    expect(output.run).toEqual({ status: "starting", lastError: null });
  });

  it("refuses to report success when the created thread carries a different model", async () => {
    const { executor } = executorWith({
      threadSnapshot: vi.fn(async () =>
        detailSnapshot(
          projection({
            modelSelection: {
              instanceId: "inst-a",
              model: "model-b",
            } as ModelSelection,
          }),
        ),
      ),
    });
    const failure = await failureOf(() => executor.startThread(baseInput));
    expect(failure.error.code).toBe("invalid_request");
    expect(failure.error.model).toBe("model-a");
  });
});

// ---------------------------------------------------------------------------
// Pre-dispatch validation
// ---------------------------------------------------------------------------

describe("startThread pre-dispatch validation", () => {
  it("fails model_unavailable for a disabled provider before any dispatch", async () => {
    const { executor, access } = executorWith({
      serverConfig: vi.fn(async () => ({
        providers: [serverProvider({ instanceId: "inst-a", enabled: false })],
      })),
    });
    const failure = await failureOf(() => executor.startThread(baseInput));
    expect(failure.error.code).toBe("model_unavailable");
    expect(failure.error.model).toBe("model-a");
    expect(failure.error.environmentId).toBe(envA);
    expect(access.launchThread as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("fails model_unavailable for an unavailable provider and surfaces the reason", async () => {
    const { executor, access } = executorWith({
      serverConfig: vi.fn(async () => ({
        providers: [
          serverProvider({
            instanceId: "inst-a",
            availability: "unavailable",
            unavailableReason: "driver not installed",
          }),
        ],
      })),
    });
    const failure = await failureOf(() => executor.startThread(baseInput));
    expect(failure.error.code).toBe("model_unavailable");
    expect(failure.error.message).toContain("driver not installed");
    expect(access.launchThread as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("fails model_unavailable when the slug is missing from the provider's models", async () => {
    const { executor, access } = executorWith({
      serverConfig: vi.fn(async () => ({
        providers: [
          serverProvider({
            instanceId: "inst-a",
            models: [{ slug: "other-model", name: "Other", isCustom: false, capabilities: null }],
          }),
        ],
      })),
    });
    const failure = await failureOf(() => executor.startThread(baseInput));
    expect(failure.error.code).toBe("model_unavailable");
    expect(access.launchThread as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("fails model_unavailable for an unknown provider instance", async () => {
    const { executor, access } = executorWith();
    const failure = await failureOf(() =>
      executor.startThread({
        ...baseInput,
        modelSelection: { instanceId: "inst-zzz", model: "model-a" } as ModelSelection,
      }),
    );
    expect(failure.error.code).toBe("model_unavailable");
    expect(access.launchThread as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("refuses a fabricated environment from the catalog with no network call", async () => {
    const { executor, host } = executorWith();
    const failure = await failureOf(() =>
      executor.startThread({ ...baseInput, environmentId: EnvironmentId.make("env-ghost") }),
    );
    expect(failure.error.code).toBe("environment_not_in_catalog");
    expect(host.openEnvironment as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("surfaces a failed launch as project_not_found", async () => {
    const { executor, access } = executorWith({
      launchThread: vi.fn(async () => {
        throw {
          _tag: "OrchestrationV2ThreadLaunchError",
          commandId: "cmd",
          projectId: projectA,
          message: "Failed to launch thread",
        };
      }),
    });
    const failure = await failureOf(() => executor.startThread(baseInput));
    expect(failure.error.code).toBe("project_not_found");
    expect(failure.error.projectId).toBe(projectA);
    // The launch was attempted: the server invariant is the authority for
    // fabricated project ids, so the client does not pre-block on a possibly
    // stale snapshot.
    expect(access.launchThread as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });

  it("surfaces a generic launch failure as environment_unreachable", async () => {
    const { executor } = executorWith({
      launchThread: vi.fn(async () => {
        throw new Error("engine offline");
      }),
    });
    const failure = await failureOf(() => executor.startThread(baseInput));
    expect(failure.error.code).toBe("environment_unreachable");
  });
});

// ---------------------------------------------------------------------------
// Replay: exactly one thread per request
// ---------------------------------------------------------------------------

describe("startThread replay", () => {
  it("short-circuits a same-request replay to the recorded outcome without a second launch", async () => {
    const { executor, access } = executorWith();
    const first = await executor.startThread(baseInput);
    const second = await executor.startThread(baseInput);
    expect(access.launchThread as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(second.dispatchSequence).toBe(first.dispatchSequence);
  });

  it("replays into the server receipt-idempotent launch after a restart", async () => {
    const first = executorWith();
    const created = await first.executor.startThread(baseInput);
    const ids = await deriveVoiceRequestIdentifiers(baseInput.requestId);
    expect(created.commandId).toBe(ids.commandId);

    // A fresh executor simulates a client restart: no in-memory record. The
    // mocked launch echoes the same identity, as the engine's command-receipt
    // replay would for the identical launch input.
    const launch = vi.fn(async (): Promise<OrchestrationV2ThreadLaunchResult> => ({
      threadId: created.threadId,
      projection: projectionWithRuns([runFixture({ status: "running" })]),
      resumed: true,
    }));
    const restarted = executorWith({ launchThread: launch });
    const replayed = await restarted.executor.startThread(baseInput);

    expect(launch).toHaveBeenCalledTimes(1);
    const input = dispatchedLaunch(restarted.access);
    expect(input.commandId).toBe(created.commandId);
    expect(replayed.threadId).toBe(created.threadId);
    expect(replayed.commandId).toBe(created.commandId);
  });

  it("refuses a changed destination under the same request id", async () => {
    const { executor, access } = executorWith();
    await executor.startThread(baseInput);
    const failure = await failureOf(() =>
      executor.startThread({
        ...baseInput,
        task: "A completely different task",
        modelSelection: { instanceId: "inst-a", model: "model-b" } as ModelSelection,
      }),
    );
    expect(failure.error.code).toBe("invalid_request");
    expect(access.launchThread as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Denials propagate from the target
// ---------------------------------------------------------------------------

describe("startThread denials", () => {
  it("propagates insufficient_scope from the target on launch", async () => {
    const { executor } = executorWith({
      launchThread: vi.fn(async () => {
        throw { _tag: "EnvironmentAuthorizationError", message: "missing orchestration:operate" };
      }),
    });
    const failure = await failureOf(() => executor.startThread(baseInput));
    expect(failure.error.code).toBe("insufficient_scope");
  });

  it("propagates auth_invalid from the target after session revocation", async () => {
    const { executor } = executorWith({
      launchThread: vi.fn(async () => {
        throw { _tag: "EnvironmentAuthInvalidError", message: "session revoked" };
      }),
    });
    const failure = await failureOf(() => executor.startThread(baseInput));
    expect(failure.error.code).toBe("auth_invalid");
  });

  it("propagates a denial from the project read without launching", async () => {
    const { executor, access } = executorWith({
      shellSnapshot: vi.fn(async () => {
        throw { _tag: "EnvironmentAuthorizationError", message: "read denied" };
      }),
    });
    const failure = await failureOf(() => executor.startThread(baseInput));
    expect(failure.error.code).toBe("insufficient_scope");
    expect(access.launchThread as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("refuses creation when the environment boundary cannot launch", async () => {
    const access = accessMock();
    const { launchThread: _omitted, ...withoutLaunch } = access as VoiceEnvironmentAccess & {
      launchThread?: unknown;
    };
    void _omitted;
    const host = hostMock({
      entries: [catalogEntry({ environmentId: envA })],
      access: withoutLaunch as VoiceEnvironmentAccess,
    });
    const executor = createVoiceToolExecutor(host);
    const failure = await failureOf(() => executor.startThread(baseInput));
    expect(failure.error.code).toBe("environment_unreachable");
  });
});
