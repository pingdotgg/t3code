import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ClientOrchestrationCommand,
  type DispatchResult,
  type ModelSelection,
  type VoiceRequestId,
} from "@t3tools/contracts";
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

const modelSelection = { instanceId: "inst-a", model: "model-a" } as ModelSelection;

const baseInput = {
  requestId: "voice-request-t5-1" as VoiceRequestId,
  environmentId: envA,
  projectId: projectA,
  task: "Investigate the flaky deploy",
  modelSelection,
};

describe("existing-thread follow-ups", () => {
  it("does not dispatch when the existing thread's provider is unavailable", async () => {
    const { executor, access } = executorWith({
      threadExists: true,
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
    const { executor, access } = executorWith({ threadExists: true });
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
    const command = dispatchedTurnStart(access);
    expect(command.threadId).toBe(input.threadId);
    expect(command.message.text).toBe(input.task);
    expect(command.bootstrap).toBeUndefined();
    expect(command.titleSeed).toBeUndefined();
    expect(command.modelSelection).toEqual(modelSelection);
    await expect(
      executor.continueThread({ ...input, threadId: ThreadId.make("other") }),
    ).rejects.toThrow();
  });

  it("never bootstraps a replacement if the existing thread is missing", async () => {
    const { executor, access } = executorWith();
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

  it("reports an accepted follow-up as starting instead of echoing the stale pre-dispatch session error", async () => {
    // The incident: after a server restart the startup reconciliation settles
    // the orphaned session as error. The provider reactor only projects the
    // new turn's session-set later, so the post-dispatch read-back still
    // showed the reconciliation error and the follow-up was narrated as a
    // dead worker while the work was in fact running.
    const staleSession = {
      status: "error",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError:
        "Provider session did not survive a server restart. Send a new message to continue.",
      updatedAt: "2026-09-15T01:10:00.000Z",
    };
    const { executor, access } = executorWith({
      threadExists: true,
      threadSnapshot: vi.fn(async (threadId: string) =>
        detailSnapshot(detailThread({ id: threadId, session: staleSession })),
      ),
    });
    const output = await executor.continueThread({
      requestId: baseInput.requestId,
      environmentId: envA,
      threadId: ThreadId.make("existing-plan"),
      task: "Please give me an update",
    });
    // The dispatch receipt still proves acceptance and the turn identity.
    expect(access.dispatchCommand as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
    expect(output.dispatchSequence).toBe(42);
    expect(output.commandId).toBeTruthy();
    expect(output.messageId).toBeTruthy();
    // The stale terminal status and its inherited error are not reported as
    // this follow-up's outcome; the honest in-flight state is.
    expect(output.session).toEqual({ status: "starting", lastError: null });
  });

  it("reports a genuine post-dispatch session advance as observed, including a new error", async () => {
    const staleSession = {
      status: "error",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: "Provider session did not survive a server restart.",
      updatedAt: "2026-09-15T01:10:00.000Z",
    };
    const advancedSession = {
      ...staleSession,
      status: "error",
      lastError: "provider turn.start failed: model unavailable",
      updatedAt: "2026-09-15T01:12:00.000Z",
    };
    const threadSnapshot = vi
      .fn()
      .mockImplementationOnce(async (threadId: string) =>
        detailSnapshot(detailThread({ id: threadId, session: staleSession })),
      )
      .mockImplementationOnce(async (threadId: string) =>
        detailSnapshot(detailThread({ id: threadId, session: advancedSession })),
      );
    const { executor } = executorWith({ threadExists: true, threadSnapshot });
    const output = await executor.continueThread({
      requestId: baseInput.requestId,
      environmentId: envA,
      threadId: ThreadId.make("existing-plan"),
      task: "Please give me an update",
    });
    expect(output.session).toEqual({
      status: "error",
      lastError: "provider turn.start failed: model unavailable",
    });
  });

  it("reports a follow-up that advanced the session to running as running", async () => {
    const staleSession = {
      status: "error",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: "Provider session did not survive a server restart.",
      updatedAt: "2026-09-15T01:10:00.000Z",
    };
    const threadSnapshot = vi
      .fn()
      .mockImplementationOnce(async (threadId: string) =>
        detailSnapshot(detailThread({ id: threadId, session: staleSession })),
      )
      .mockImplementationOnce(async (threadId: string) =>
        detailSnapshot(
          detailThread({
            id: threadId,
            session: {
              ...staleSession,
              status: "running",
              lastError: null,
              updatedAt: "2026-09-15T01:12:00.000Z",
            },
          }),
        ),
      );
    const { executor } = executorWith({ threadExists: true, threadSnapshot });
    const output = await executor.continueThread({
      requestId: baseInput.requestId,
      environmentId: envA,
      threadId: ThreadId.make("existing-plan"),
      task: "Please give me an update",
    });
    expect(output.session).toEqual({ status: "running", lastError: null });
  });

  it("reports an unchanged live running session as observed", async () => {
    // A worker genuinely running across the dispatch stays running; the
    // follow-up is delivered to a live thread.
    const { executor } = executorWith({ threadExists: true });
    const output = await executor.continueThread({
      requestId: baseInput.requestId,
      environmentId: envA,
      threadId: ThreadId.make("existing-plan"),
      task: "Please give me an update",
    });
    expect(output.session).toEqual({ status: "running", lastError: null });
  });
});

type TurnStartCommand = Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
  defaultModelSelection: null;
  scripts: never[];
  createdAt: string;
  updatedAt: string;
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
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-09-01T09:00:00.000Z",
    updatedAt: "2026-09-02T09:00:00.000Z",
    ...(overrides.defaultThreadEnvMode !== undefined
      ? { defaultThreadEnvMode: overrides.defaultThreadEnvMode }
      : {}),
  };
}

function shellSnapshotFixture(projects: ShellProjectFixture[]): {
  snapshotSequence: number;
  projects: ShellProjectFixture[];
  threads: never[];
  updatedAt: string;
} {
  return { snapshotSequence: 7, projects, threads: [], updatedAt: "2026-09-03T00:00:00.000Z" };
}

interface DetailThreadFixture {
  id: string;
  projectId: ProjectId;
  title: string;
  modelSelection: ModelSelection | null;
  runtimeMode: string;
  interactionMode: string;
  branch: null;
  worktreePath: null;
  latestTurn: null;
  createdAt: string;
  updatedAt: string;
  archivedAt: null;
  settledOverride: null;
  settledAt: null;
  deletedAt: null;
  messages: never[];
  proposedPlans: never[];
  activities: never[];
  checkpoints: never[];
  session: Record<string, unknown> | null;
}

function detailThread(overrides: {
  id: string;
  modelSelection?: ModelSelection | null;
  session?: Record<string, unknown> | null;
}): DetailThreadFixture {
  return {
    id: overrides.id,
    projectId: projectA,
    title: "Thread",
    modelSelection: overrides.modelSelection ?? modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-02T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: overrides.session ?? null,
  };
}

function detailSnapshot(thread: DetailThreadFixture): {
  snapshotSequence: number;
  thread: DetailThreadFixture;
} {
  return { snapshotSequence: 11, thread };
}

function runningSession(): Record<string, unknown> {
  return {
    status: "running",
    providerName: "claude",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: "2026-09-02T10:00:00.000Z",
  };
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
  readonly threadSnapshot?: (threadId: string) => Promise<unknown>;
  readonly dispatchCommand?: (command: ClientOrchestrationCommand) => Promise<DispatchResult>;
  readonly listRefs?: (cwd: string) => Promise<unknown>;
  /** When true the thread-existence probe finds the thread (replay after
      restart, or a probe failure to propagate). Default: the probe misses, so
      creation dispatches with bootstrap. */
  readonly threadExists?: boolean;
}

function accessMock(overrides: StartAccessOverrides = {}): VoiceEnvironmentAccess {
  const baseSnapshot =
    overrides.threadSnapshot ??
    vi.fn(async (threadId: string) =>
      detailSnapshot(detailThread({ id: threadId, session: runningSession() })),
    );
  const threadSnapshot =
    overrides.threadExists === true
      ? baseSnapshot
      : (() => {
          let probed = false;
          return vi.fn(async (threadId: string) => {
            // First read is the creation-time existence probe: the thread
            // does not exist yet. Later reads are the post-dispatch read-back.
            if (!probed) {
              probed = true;
              throw {
                _tag: "EnvironmentResourceNotFoundError",
                message: "thread not found",
              };
            }
            return baseSnapshot(threadId);
          });
        })();
  return {
    shellSnapshot:
      overrides.shellSnapshot ??
      vi.fn(async () => shellSnapshotFixture([projectShell({ id: projectA })])),
    archivedShellSnapshot: vi.fn(async () => shellSnapshotFixture([])),
    searchThreads: vi.fn(async () => ({ matches: [] })),
    threadSnapshot,
    serverConfig:
      overrides.serverConfig ??
      vi.fn(async () => ({
        providers: providersFixture(),
        settings: { newWorktreesStartFromOrigin: true },
      })),
    subscribeThread: vi.fn(async () => ({ kind: "synchronized" })),
    listRefs:
      overrides.listRefs ??
      vi.fn(async () => refsResult([ref("main", { current: true, isDefault: true })])),
    dispatchCommand:
      overrides.dispatchCommand ?? vi.fn(async (): Promise<DispatchResult> => ({ sequence: 42 })),
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

function dispatchedTurnStart(access: VoiceEnvironmentAccess, callIndex = 0): TurnStartCommand {
  const dispatch = access.dispatchCommand as ReturnType<typeof vi.fn> | undefined;
  const call = dispatch?.mock.calls[callIndex]?.[0] as ClientOrchestrationCommand | undefined;
  if (call === undefined || call.type !== "thread.turn.start") {
    throw new Error("expected a thread.turn.start dispatch");
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
  it("dispatches exactly one thread.turn.start with the derived ids and reads back the session", async () => {
    const { executor, access } = executorWith();
    const output = await executor.startThread({ ...baseInput, title: "My title" });
    const dispatch = access.dispatchCommand as ReturnType<typeof vi.fn>;
    const threadSnapshot = access.threadSnapshot as ReturnType<typeof vi.fn>;

    expect(dispatch).toHaveBeenCalledTimes(1);
    const command = dispatchedTurnStart(access);
    const ids = await deriveVoiceRequestIdentifiers(baseInput.requestId);
    expect(command.commandId).toBe(ids.commandId);
    expect(command.threadId).toBe(ids.threadId);
    expect(command.message.messageId).toBe(ids.messageId);
    expect(command.message.role).toBe("user");
    expect(command.message.text).toBe(baseInput.task);
    expect(command.message.attachments).toEqual([]);
    expect(output.commandId).toBe(ids.commandId);
    expect(output.threadId).toBe(ids.threadId);
    expect(output.messageId).toBe(ids.messageId);
    expect(output.dispatchSequence).toBe(42);
    expect(output.environment).toEqual({ environmentId: envA, status: "ok" });
    expect(output.session).toEqual({ status: "running", lastError: null });
    expect(threadSnapshot).toHaveBeenCalledWith(ids.threadId, { turnLimit: 1 });
  });

  it("carries title and titleSeed with the same value into both command and bootstrap", async () => {
    const { executor, access } = executorWith();
    await executor.startThread({ ...baseInput, title: "My title" });
    const command = dispatchedTurnStart(access);
    expect(command.titleSeed).toBe("My title");
    expect(command.bootstrap?.createThread?.title).toBe("My title");
  });

  it("derives the title from the task when none was given", async () => {
    const { executor, access } = executorWith();
    await executor.startThread(baseInput);
    const command = dispatchedTurnStart(access);
    expect(command.titleSeed).toBe(baseInput.task);
    expect(command.bootstrap?.createThread?.title).toBe(baseInput.task);
  });

  it("sends the server's own default runtime mode, never a hardcoded literal", async () => {
    const { executor, access } = executorWith();
    await executor.startThread(baseInput);
    const command = dispatchedTurnStart(access);
    expect(command.runtimeMode).toBe(DEFAULT_RUNTIME_MODE);
    expect(command.interactionMode).toBe(DEFAULT_PROVIDER_INTERACTION_MODE);
    expect(command.bootstrap?.createThread?.runtimeMode).toBe(DEFAULT_RUNTIME_MODE);
    expect(command.bootstrap?.createThread?.interactionMode).toBe(
      DEFAULT_PROVIDER_INTERACTION_MODE,
    );
    // No runtime-mode or worktree base literal may appear in the voice
    // creation source; values must come from resolved state, never literals.
    expect(toolsSource).not.toContain('"full-access"');
    expect(toolsSource).not.toContain('"HEAD"');
  });

  it("passes an explicit spoken runtime override through unchanged", async () => {
    const { executor, access } = executorWith();
    await executor.startThread({ ...baseInput, runtimeMode: "auto" });
    const command = dispatchedTurnStart(access);
    expect(command.runtimeMode).toBe("auto");
    expect(command.bootstrap?.createThread?.runtimeMode).toBe("auto");
  });

  it("refuses an unknown runtime mode literal before dispatch", async () => {
    const { executor, access } = executorWith();
    const failure = await failureOf(() =>
      executor.startThread({ ...baseInput, runtimeMode: "yolo-mode" }),
    );
    expect(failure.error.code).toBe("invalid_request");
    expect(access.dispatchCommand as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("rejects an empty task before dispatch", async () => {
    const { executor, access } = executorWith();
    const failure = await failureOf(() => executor.startThread({ ...baseInput, task: "   " }));
    expect(failure.error.code).toBe("invalid_request");
    expect(access.dispatchCommand as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("creates the thread local (null branch/worktreePath) with no prepareWorktree by default", async () => {
    const { executor, access } = executorWith();
    await executor.startThread(baseInput);
    const command = dispatchedTurnStart(access);
    expect(command.bootstrap?.createThread?.branch).toBeNull();
    expect(command.bootstrap?.createThread?.worktreePath).toBeNull();
    expect(command.bootstrap?.prepareWorktree).toBeUndefined();
    expect(command.bootstrap?.runSetupScript).toBeUndefined();
  });

  it("supplies prepareWorktree from the current ref when the project explicitly prefers worktree threads", async () => {
    const { executor, access } = executorWith({
      shellSnapshot: vi.fn(async () =>
        shellSnapshotFixture([
          projectShell({ id: projectA, defaultThreadEnvMode: "worktree", workspaceRoot: "/tmp/o" }),
        ]),
      ),
      listRefs: vi.fn(async () => refsResult([ref("main", { current: true, isDefault: true })])),
    });
    await executor.startThread(baseInput);
    const command = dispatchedTurnStart(access);
    const listRefs = access.listRefs as ReturnType<typeof vi.fn>;
    expect(listRefs).toHaveBeenCalledWith("/tmp/o");
    expect(command.bootstrap?.createThread?.branch).toBeNull();
    expect(command.bootstrap?.prepareWorktree).toBeDefined();
    expect(command.bootstrap?.prepareWorktree?.projectCwd).toBe("/tmp/o");
    expect(command.bootstrap?.prepareWorktree?.baseBranch).toBe("main");
    expect(command.bootstrap?.prepareWorktree?.baseBranch).not.toBe("HEAD");
    expect(command.bootstrap?.prepareWorktree?.branch).toBe(`voice-${command.threadId}`);
    expect(command.bootstrap?.runSetupScript).toBe(true);
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
    const command = dispatchedTurnStart(access);
    expect(command.bootstrap?.prepareWorktree?.baseBranch).toBe("develop");
    expect(command.bootstrap?.prepareWorktree?.baseBranch).not.toBe("HEAD");
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
    expect(access.dispatchCommand as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
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
    expect(access.dispatchCommand as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
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
    const command = dispatchedTurnStart(access);
    expect(command.bootstrap?.prepareWorktree?.startFromOrigin).toBe(true);
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
    const command = dispatchedTurnStart(access);
    expect(command.bootstrap?.prepareWorktree?.startFromOrigin).toBeUndefined();
  });

  it("treats a projected local (null env mode) as no worktree preference", async () => {
    const { executor, access } = executorWith({
      shellSnapshot: vi.fn(async () =>
        shellSnapshotFixture([projectShell({ id: projectA, defaultThreadEnvMode: null })]),
      ),
    });
    await executor.startThread(baseInput);
    const command = dispatchedTurnStart(access);
    expect(command.bootstrap?.prepareWorktree).toBeUndefined();
  });

  it("reports a worker that is still running in-band, without waiting for it", async () => {
    const { executor } = executorWith();
    const output = await executor.startThread(baseInput);
    expect(output.session?.status).toBe("running");
    expect(output.session?.lastError).toBeNull();
  });

  it("reports a fast terminal success from the read-back", async () => {
    const { executor, access } = executorWith({
      threadSnapshot: vi.fn(async (threadId: string) =>
        detailSnapshot(
          detailThread({
            id: threadId,
            session: { ...runningSession(), status: "ready", activeTurnId: null },
          }),
        ),
      ),
    });
    const output = await executor.startThread(baseInput);
    expect(output.session?.status).toBe("ready");
    expect(output.session?.lastError).toBeNull();
    expect(access.dispatchCommand as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });

  it("reports a worker error status and its lastError in-band instead of claiming success", async () => {
    const { executor } = executorWith({
      threadSnapshot: vi.fn(async (threadId: string) =>
        detailSnapshot(
          detailThread({
            id: threadId,
            session: { ...runningSession(), status: "error", lastError: "provider crashed" },
          }),
        ),
      ),
    });
    const output = await executor.startThread(baseInput);
    expect(output.session?.status).toBe("error");
    expect(output.session?.lastError).toBe("provider crashed");
  });

  it("reports an idle thread when no session exists yet", async () => {
    const { executor } = executorWith({
      threadSnapshot: vi.fn(async (threadId: string) =>
        detailSnapshot(detailThread({ id: threadId, session: null })),
      ),
    });
    const output = await executor.startThread(baseInput);
    expect(output.session).toEqual({ status: "idle", lastError: null });
  });

  it("refuses to report success when the created thread carries a different model", async () => {
    const { executor } = executorWith({
      threadSnapshot: vi.fn(async (threadId: string) =>
        detailSnapshot(
          detailThread({
            id: threadId,
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
    expect(access.dispatchCommand as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
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
    expect(access.dispatchCommand as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
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
    expect(access.dispatchCommand as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
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
    expect(access.dispatchCommand as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("refuses a fabricated environment from the catalog with no network call", async () => {
    const { executor, host } = executorWith();
    const failure = await failureOf(() =>
      executor.startThread({ ...baseInput, environmentId: EnvironmentId.make("env-ghost") }),
    );
    expect(failure.error.code).toBe("environment_not_in_catalog");
    expect(host.openEnvironment as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("surfaces the server's requireProject invariant as project_not_found", async () => {
    const { executor, access } = executorWith({
      shellSnapshot: vi.fn(async () => shellSnapshotFixture([])),
      dispatchCommand: vi.fn(async () => {
        throw {
          _tag: "OrchestrationDispatchCommandError",
          message: `Project '${projectA}' does not exist for command 'thread.turn.start'.`,
        };
      }),
    });
    const failure = await failureOf(() => executor.startThread(baseInput));
    expect(failure.error.code).toBe("project_not_found");
    expect(failure.error.projectId).toBe(projectA);
    // The dispatch was attempted: the server invariant is the authority for
    // fabricated project ids, so the client does not pre-block on a possibly
    // stale snapshot.
    expect(access.dispatchCommand as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });

  it("surfaces a generic dispatch failure as environment_unreachable", async () => {
    const { executor } = executorWith({
      dispatchCommand: vi.fn(async () => {
        throw { _tag: "OrchestrationDispatchCommandError", message: "engine offline" };
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
  it("short-circuits a same-request replay to the recorded outcome without a second dispatch", async () => {
    const { executor, access } = executorWith();
    const first = await executor.startThread(baseInput);
    const second = await executor.startThread(baseInput);
    expect(access.dispatchCommand as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(second.dispatchSequence).toBe(first.dispatchSequence);
  });

  it("replays into the server idempotency path after a restart: no bootstrap, same commandId, same sequence", async () => {
    const first = executorWith();
    const created = await first.executor.startThread(baseInput);
    const ids = await deriveVoiceRequestIdentifiers(baseInput.requestId);
    expect(created.commandId).toBe(ids.commandId);

    // A fresh executor simulates a client restart: no in-memory record. The
    // mocked dispatch returns the same sequence, as the engine's command-id
    // receipt replay would for the identical command.
    const dispatch = vi.fn(async (): Promise<DispatchResult> => ({ sequence: 42 }));
    const restarted = executorWith({ dispatchCommand: dispatch, threadExists: true });
    const replayed = await restarted.executor.startThread(baseInput);

    expect(dispatch).toHaveBeenCalledTimes(1);
    const command = dispatchedTurnStart(restarted.access);
    expect(command.commandId).toBe(created.commandId);
    expect(command.bootstrap).toBeUndefined();
    expect(replayed.dispatchSequence).toBe(created.dispatchSequence);
    expect(replayed.threadId).toBe(created.threadId);
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
    expect(access.dispatchCommand as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Denials propagate from the target
// ---------------------------------------------------------------------------

describe("startThread denials", () => {
  it("propagates insufficient_scope from the target on dispatch", async () => {
    const { executor } = executorWith({
      dispatchCommand: vi.fn(async () => {
        throw { _tag: "EnvironmentAuthorizationError", message: "missing orchestration:operate" };
      }),
    });
    const failure = await failureOf(() => executor.startThread(baseInput));
    expect(failure.error.code).toBe("insufficient_scope");
  });

  it("propagates auth_invalid from the target after session revocation", async () => {
    const { executor } = executorWith({
      dispatchCommand: vi.fn(async () => {
        throw { _tag: "EnvironmentAuthInvalidError", message: "session revoked" };
      }),
    });
    const failure = await failureOf(() => executor.startThread(baseInput));
    expect(failure.error.code).toBe("auth_invalid");
  });

  it("propagates a denial from the existence probe without dispatching", async () => {
    const { executor, access } = executorWith({
      threadExists: true,
      threadSnapshot: vi.fn(async () => {
        throw { _tag: "EnvironmentAuthorizationError", message: "read denied" };
      }),
    });
    const failure = await failureOf(() => executor.startThread(baseInput));
    expect(failure.error.code).toBe("insufficient_scope");
    expect(access.dispatchCommand as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("refuses creation when the environment boundary cannot dispatch", async () => {
    const access = accessMock();
    const { dispatchCommand: _omitted, ...withoutDispatch } = access as VoiceEnvironmentAccess & {
      dispatchCommand?: unknown;
    };
    void _omitted;
    const host = hostMock({
      entries: [catalogEntry({ environmentId: envA })],
      access: withoutDispatch as VoiceEnvironmentAccess,
    });
    const executor = createVoiceToolExecutor(host);
    const failure = await failureOf(() => executor.startThread(baseInput));
    expect(failure.error.code).toBe("environment_unreachable");
  });
});
