import {
  AVAILABLE_CONNECTION_STATE,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import {
  buildFollowUpThreadInput,
  buildStartProjectTaskInput,
  buildThreadTurnInterruptInput,
} from "@t3tools/client-runtime/operations/thread-tasks";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { deriveThreadTitleFromPrompt } from "../lib/projectThreadStartTurn";
import {
  createVoiceToolsMobileRepository,
  type VoiceToolsMobileEnvironment,
  type VoiceToolsMobileRepositoryDependencies,
} from "./voiceToolsRepository";

vi.mock("expo-crypto", () => ({
  randomUUID: vi.fn(() => "00000000-0000-4000-8000-000000000000"),
  getRandomBytes: vi.fn((byteLength: number) => new Uint8Array(byteLength)),
}));

const NOW = "2026-08-11T10:00:00.000Z";
const LATER = "2026-08-11T10:01:00.000Z";
const ENVIRONMENT_A = EnvironmentId.make("environment-mobile-a");
const ENVIRONMENT_B = EnvironmentId.make("environment-mobile-b");
const ENVIRONMENT_C = EnvironmentId.make("environment-mobile-c");
const PROJECT_ID = ProjectId.make("project-mobile-shared");
const THREAD_ID = ThreadId.make("thread-mobile-shared");
const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("codex-mobile"),
  model: "gpt-mobile",
} satisfies ModelSelection;

const CONNECTED: SupervisorConnectionState = {
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase: "connected",
  attempt: 1,
  generation: 1,
};

const CONNECTING: SupervisorConnectionState = {
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase: "connecting",
  stage: "synchronizing",
  attempt: 1,
  generation: 1,
};

function project(overrides: Partial<OrchestrationProjectShell> = {}): OrchestrationProjectShell {
  return {
    id: PROJECT_ID,
    title: "Shared mobile project",
    workspaceRoot: "/workspace/mobile",
    repositoryIdentity: null,
    defaultModelSelection: MODEL_SELECTION,
    defaultThreadEnvMode: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function thread(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Shared mobile thread",
    modelSelection: MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function environment(input: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connectionState?: SupervisorConnectionState;
  readonly shellStatus?: EnvironmentShellState["status"];
  readonly projects?: ReadonlyArray<OrchestrationProjectShell>;
  readonly threads?: ReadonlyArray<OrchestrationThreadShell>;
}): VoiceToolsMobileEnvironment {
  const snapshot: OrchestrationShellSnapshot = {
    snapshotSequence: 1,
    projects: input.projects ?? [project()],
    threads: input.threads ?? [thread()],
    updatedAt: NOW,
  };
  return {
    environmentId: input.environmentId,
    label: input.label,
    connectionState: input.connectionState ?? CONNECTED,
    shellState: {
      snapshot: Option.some(snapshot),
      status: input.shellStatus ?? "live",
      error: Option.none(),
    },
  };
}

function harness(readEnvironments: () => ReadonlyArray<VoiceToolsMobileEnvironment>) {
  const resolveStartThreadDefaults = vi.fn<
    VoiceToolsMobileRepositoryDependencies["resolveStartThreadDefaults"]
  >(async () => ({
    modelSelection: MODEL_SELECTION,
    workspace: { mode: "local", branch: null, worktreePath: null },
  }));
  const navigate = vi.fn<VoiceToolsMobileRepositoryDependencies["navigate"]>(async () => undefined);
  const startThreadTurn = vi.fn<VoiceToolsMobileRepositoryDependencies["startThreadTurn"]>(
    async () => AsyncResult.success({ sequence: 1 }),
  );
  const interruptThreadTurn = vi.fn<VoiceToolsMobileRepositoryDependencies["interruptThreadTurn"]>(
    async () => AsyncResult.success({ sequence: 2 }),
  );
  const makeCommandId = vi.fn(() => CommandId.make("command-mobile"));
  const makeMessageId = vi.fn(() => MessageId.make("message-mobile"));
  const makeThreadId = vi.fn(() => ThreadId.make("thread-created-mobile"));
  const now = vi.fn(() => NOW);
  const randomHex = vi.fn(() => "deadbeef");
  const repository = createVoiceToolsMobileRepository({
    readEnvironments,
    resolveStartThreadDefaults,
    navigate,
    startThreadTurn,
    interruptThreadTurn,
    makeCommandId,
    makeMessageId,
    makeThreadId,
    now,
    randomHex,
  });
  return {
    repository,
    resolveStartThreadDefaults,
    navigate,
    startThreadTurn,
    interruptThreadTurn,
    makeCommandId,
    makeMessageId,
    makeThreadId,
    now,
    randomHex,
  };
}

function firstProject(repository: ReturnType<typeof createVoiceToolsMobileRepository>) {
  const record = repository.listProjects()[0];
  if (record === undefined) throw new Error("Expected a mobile project fixture.");
  return record;
}

function firstThread(repository: ReturnType<typeof createVoiceToolsMobileRepository>) {
  const record = repository.listThreads()[0];
  if (record === undefined) throw new Error("Expected a mobile thread fixture.");
  return record;
}

describe("createVoiceToolsMobileRepository", () => {
  it("lists duplicate targets across environments with qualified labels and cached availability", () => {
    const test = harness(() => [
      environment({ environmentId: ENVIRONMENT_A, label: "Phone host" }),
      environment({
        environmentId: ENVIRONMENT_B,
        label: "Desktop host",
        connectionState: CONNECTING,
        shellStatus: "synchronizing",
      }),
      environment({
        environmentId: ENVIRONMENT_C,
        label: "Remote host",
        connectionState: AVAILABLE_CONNECTION_STATE,
        shellStatus: "cached",
      }),
    ]);

    expect(
      test.repository.listProjects().map((record) => ({
        environmentId: record.project.environmentId,
        displayLabel: record.displayLabel,
        availability: record.availability,
      })),
    ).toEqual([
      {
        environmentId: ENVIRONMENT_A,
        displayLabel: "Shared mobile project · Phone host",
        availability: "live",
      },
      {
        environmentId: ENVIRONMENT_B,
        displayLabel: "Shared mobile project · Desktop host",
        availability: "stale",
      },
      {
        environmentId: ENVIRONMENT_C,
        displayLabel: "Shared mobile project · Remote host",
        availability: "disconnected",
      },
    ]);
    expect(test.repository.listThreads().map((record) => record.displayLabel)).toEqual([
      "Shared mobile thread · Phone host",
      "Shared mobile thread · Desktop host",
      "Shared mobile thread · Remote host",
    ]);
  });

  it("revalidates exact live target versions and rejects removed snapshots", () => {
    let environments = [environment({ environmentId: ENVIRONMENT_A, label: "Phone host" })];
    const test = harness(() => environments);
    const originalProjectVersion = test.repository.getProject(ENVIRONMENT_A, PROJECT_ID)?.version;
    const originalThreadVersion = test.repository.getThread(ENVIRONMENT_A, THREAD_ID)?.version;

    environments = [
      environment({
        environmentId: ENVIRONMENT_A,
        label: "Phone host",
        projects: [project({ updatedAt: LATER })],
        threads: [thread({ updatedAt: LATER })],
      }),
    ];
    expect(test.repository.getProject(ENVIRONMENT_A, PROJECT_ID)?.version).not.toBe(
      originalProjectVersion,
    );
    expect(test.repository.getThread(ENVIRONMENT_A, THREAD_ID)?.version).not.toBe(
      originalThreadVersion,
    );

    environments = [];
    expect(test.repository.getProject(ENVIRONMENT_A, PROJECT_ID)).toBeNull();
    expect(test.repository.getThread(ENVIRONMENT_A, THREAD_ID)).toBeNull();
  });

  it("prepares local and worktree starts with mobile title and metadata behavior", async () => {
    const test = harness(() => [
      environment({ environmentId: ENVIRONMENT_A, label: "Phone host" }),
    ]);
    const target = firstProject(test.repository);
    const instruction = `  Build   the mobile voice task ${"carefully ".repeat(10)}`;

    const local = await test.repository.prepareStartThread({ project: target, instruction });
    const title = deriveThreadTitleFromPrompt(instruction);
    expect(local).toEqual({
      commandId: CommandId.make("command-mobile"),
      messageId: MessageId.make("message-mobile"),
      threadId: ThreadId.make("thread-created-mobile"),
      createdAt: NOW,
      title,
      titleSeed: title,
      modelSelection: MODEL_SELECTION,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspace: { mode: "local", branch: null, worktreePath: null },
    });
    expect(title).toHaveLength(72);
    expect(test.randomHex).not.toHaveBeenCalled();

    test.resolveStartThreadDefaults.mockResolvedValueOnce({
      modelSelection: MODEL_SELECTION,
      workspace: { mode: "worktree", baseBranch: "release", startFromOrigin: false },
    });
    const worktree = await test.repository.prepareStartThread({
      project: target,
      instruction: "Use a mobile worktree",
    });
    expect(worktree.workspace).toEqual({
      mode: "worktree",
      projectCwd: "/workspace/mobile",
      baseBranch: "release",
      worktreeBranch: "t3code/deadbeef",
      startFromOrigin: false,
    });
    expect(test.randomHex).toHaveBeenCalledExactlyOnceWith(4);
    expect(test.makeCommandId).toHaveBeenCalledTimes(2);
    expect(test.makeMessageId).toHaveBeenCalledTimes(2);
    expect(test.makeThreadId).toHaveBeenCalledTimes(2);
    expect(test.now).toHaveBeenCalledTimes(2);
  });

  it("uses the production mobile UUID, clock, and random helpers when not injected", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    try {
      const repository = createVoiceToolsMobileRepository({
        readEnvironments: () => [
          environment({ environmentId: ENVIRONMENT_A, label: "Phone host" }),
        ],
        resolveStartThreadDefaults: async () => ({
          modelSelection: MODEL_SELECTION,
          workspace: { mode: "worktree", baseBranch: "main", startFromOrigin: true },
        }),
        navigate: async () => undefined,
        startThreadTurn: async () => AsyncResult.success({ sequence: 1 }),
        interruptThreadTurn: async () => AsyncResult.success({ sequence: 2 }),
      });

      await expect(
        repository.prepareStartThread({
          project: firstProject(repository),
          instruction: "Use production mobile helpers",
        }),
      ).resolves.toMatchObject({
        commandId: CommandId.make("00000000-0000-4000-8000-000000000000"),
        messageId: MessageId.make("00000000-0000-4000-8000-000000000000"),
        threadId: ThreadId.make("00000000-0000-4000-8000-000000000000"),
        createdAt: NOW,
        workspace: {
          mode: "worktree",
          worktreeBranch: "t3code/00000000",
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("navigates and dispatches start, follow-up, and interrupt to the exact environment", async () => {
    const test = harness(() => [
      environment({ environmentId: ENVIRONMENT_B, label: "Desktop host" }),
    ]);
    const projectTarget = firstProject(test.repository);
    const threadTarget = firstThread(test.repository);

    await test.repository.openThread(threadTarget);
    expect(test.navigate).toHaveBeenCalledExactlyOnceWith("Thread", {
      environmentId: ENVIRONMENT_B,
      threadId: THREAD_ID,
    });

    const startPreparation = await test.repository.prepareStartThread({
      project: projectTarget,
      instruction: "Start from mobile voice",
    });
    const start = buildStartProjectTaskInput({
      ...startPreparation,
      projectId: PROJECT_ID,
      text: "Start from mobile voice",
      attachments: [],
    });
    await expect(
      test.repository.startThreadTurn({ environmentId: ENVIRONMENT_B, command: start }),
    ).resolves.toEqual({ status: "accepted" });

    const followPreparation = await test.repository.prepareFollowUp({
      thread: threadTarget,
      instruction: "Continue from mobile voice",
    });
    const followUp = buildFollowUpThreadInput({
      ...followPreparation,
      thread: threadTarget.thread,
      text: "Continue from mobile voice",
      attachments: [],
    });
    await expect(
      test.repository.startThreadTurn({ environmentId: ENVIRONMENT_B, command: followUp }),
    ).resolves.toEqual({ status: "accepted" });
    expect(test.startThreadTurn).toHaveBeenNthCalledWith(1, {
      environmentId: ENVIRONMENT_B,
      input: start,
    });
    expect(test.startThreadTurn).toHaveBeenNthCalledWith(2, {
      environmentId: ENVIRONMENT_B,
      input: followUp,
    });

    const interruptPreparation = await test.repository.prepareInterrupt({ thread: threadTarget });
    const interrupt = buildThreadTurnInterruptInput({
      ...interruptPreparation,
      thread: threadTarget.thread,
    });
    await expect(
      test.repository.interruptThreadTurn({ environmentId: ENVIRONMENT_B, command: interrupt }),
    ).resolves.toEqual({ status: "accepted" });
    expect(test.interruptThreadTurn).toHaveBeenCalledExactlyOnceWith({
      environmentId: ENVIRONMENT_B,
      input: interrupt,
    });
  });

  it("surfaces live receipt failures without an offline outbox fallback", async () => {
    const startFailure = new Error("start rejected");
    const interruptFailure = new Error("interrupt rejected");
    const test = harness(() => [
      environment({ environmentId: ENVIRONMENT_A, label: "Phone host" }),
    ]);
    const projectTarget = firstProject(test.repository);
    const threadTarget = firstThread(test.repository);
    test.startThreadTurn.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(startFailure)));
    test.interruptThreadTurn.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(interruptFailure)),
    );

    const startPreparation = await test.repository.prepareStartThread({
      project: projectTarget,
      instruction: "Do not queue this",
    });
    const start = buildStartProjectTaskInput({
      ...startPreparation,
      projectId: PROJECT_ID,
      text: "Do not queue this",
      attachments: [],
    });
    await expect(
      test.repository.startThreadTurn({ environmentId: ENVIRONMENT_A, command: start }),
    ).rejects.toBe(startFailure);

    const interruptPreparation = await test.repository.prepareInterrupt({ thread: threadTarget });
    const interrupt = buildThreadTurnInterruptInput({
      ...interruptPreparation,
      thread: threadTarget.thread,
    });
    await expect(
      test.repository.interruptThreadTurn({ environmentId: ENVIRONMENT_A, command: interrupt }),
    ).rejects.toBe(interruptFailure);
    expect(test.startThreadTurn).toHaveBeenCalledTimes(1);
    expect(test.interruptThreadTurn).toHaveBeenCalledTimes(1);
  });
});
