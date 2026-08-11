import { AVAILABLE_CONNECTION_STATE, type SupervisorConnectionState } from "../connection/model.ts";
import {
  buildFollowUpThreadInput,
  buildStartProjectTaskInput,
  buildThreadTurnInterruptInput,
} from "./threadTasks.ts";
import type { EnvironmentShellState } from "../state/shell.ts";
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
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { truncate } from "@t3tools/shared/String";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";

import {
  createVoiceSupervisorRepository,
  type VoiceSupervisorEnvironment,
  type VoiceSupervisorRepositoryDependencies,
  type VoiceSupervisorStartThreadDefaults,
} from "./voiceSupervisorRepository.ts";
import { MAX_VOICE_TARGET_LABEL_CHARS } from "./voiceSupervisorTools.ts";

const NOW = "2026-08-10T12:00:00.000Z";
const LATER = "2026-08-10T12:01:00.000Z";
const ENVIRONMENT_A = EnvironmentId.make("environment-a");
const ENVIRONMENT_B = EnvironmentId.make("environment-b");
const ENVIRONMENT_C = EnvironmentId.make("environment-c");
const PROJECT_ID = ProjectId.make("project-shared");
const THREAD_ID = ThreadId.make("thread-shared");
const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("codex-default"),
  model: "gpt-5.4",
  options: [{ id: "reasoningEffort", value: "high" }],
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
    title: "Shared project",
    workspaceRoot: "/workspace/shared",
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
    title: "Shared thread",
    modelSelection: MODEL_SELECTION,
    runtimeMode: "auto-accept-edits",
    interactionMode: "plan",
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
  readonly snapshotSequence?: number;
  readonly projects?: ReadonlyArray<OrchestrationProjectShell>;
  readonly threads?: ReadonlyArray<OrchestrationThreadShell>;
}): VoiceSupervisorEnvironment {
  const snapshot: OrchestrationShellSnapshot = {
    snapshotSequence: input.snapshotSequence ?? 1,
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

function makeDependencies(input: {
  readonly readEnvironments: () => ReadonlyArray<VoiceSupervisorEnvironment>;
  readonly defaults?: VoiceSupervisorStartThreadDefaults;
}) {
  const openThread = vi.fn<VoiceSupervisorRepositoryDependencies["openThread"]>(
    async () => undefined,
  );
  const startThreadTurn = vi.fn<VoiceSupervisorRepositoryDependencies["startThreadTurn"]>(
    async () => AsyncResult.success({ sequence: 1 }),
  );
  const interruptThreadTurn = vi.fn<VoiceSupervisorRepositoryDependencies["interruptThreadTurn"]>(
    async () => AsyncResult.success({ sequence: 2 }),
  );
  const resolveStartThreadDefaults = vi.fn<
    VoiceSupervisorRepositoryDependencies["resolveStartThreadDefaults"]
  >(
    async () =>
      input.defaults ?? {
        modelSelection: MODEL_SELECTION,
        workspace: { mode: "local", branch: "main", worktreePath: null },
      },
  );
  const makeCommandId = vi.fn(() => CommandId.make("command-generated"));
  const makeMessageId = vi.fn(() => MessageId.make("message-generated"));
  const makeThreadId = vi.fn(() => ThreadId.make("thread-generated"));
  const now = vi.fn(() => NOW);
  const randomHex = vi.fn(() => "deadbeef");
  const formatTitle = vi.fn(truncate);

  return {
    dependencies: {
      readEnvironments: input.readEnvironments,
      resolveStartThreadDefaults,
      openThread,
      startThreadTurn,
      interruptThreadTurn,
      makeCommandId,
      makeMessageId,
      makeThreadId,
      now,
      randomHex,
      formatTitle,
    } satisfies VoiceSupervisorRepositoryDependencies,
    openThread,
    startThreadTurn,
    interruptThreadTurn,
    resolveStartThreadDefaults,
    makeCommandId,
    makeMessageId,
    makeThreadId,
    now,
    randomHex,
    formatTitle,
  };
}

function firstProject(repository: ReturnType<typeof createVoiceSupervisorRepository>) {
  const record = repository.listProjects()[0];
  if (record === undefined) throw new Error("Expected a project fixture.");
  return record;
}

function firstThread(repository: ReturnType<typeof createVoiceSupervisorRepository>) {
  const record = repository.listThreads()[0];
  if (record === undefined) throw new Error("Expected a thread fixture.");
  return record;
}

describe("createVoiceSupervisorRepository", () => {
  it("preserves environment qualifiers when duplicate project titles are very long", () => {
    const sharedTitle = `Shared ${"project ".repeat(80)}`.trimEnd();
    const environments = [
      environment({
        environmentId: ENVIRONMENT_A,
        label: "Laptop",
        projects: [project({ id: ProjectId.make("project-long-a"), title: sharedTitle })],
        threads: [],
      }),
      environment({
        environmentId: ENVIRONMENT_B,
        label: "Desktop",
        projects: [project({ id: ProjectId.make("project-long-b"), title: sharedTitle })],
        threads: [],
      }),
    ];
    const repository = createVoiceSupervisorRepository(
      makeDependencies({ readEnvironments: () => environments }).dependencies,
    );
    const labels = repository.listProjects().map((record) => record.displayLabel);

    expect(labels).toEqual([
      expect.stringMatching(/ · Laptop$/),
      expect.stringMatching(/ · Desktop$/),
    ]);
    expect(new Set(labels).size).toBe(2);
    expect(labels.every((label) => label.length <= MAX_VOICE_TARGET_LABEL_CHARS)).toBe(true);
  });

  it("lists duplicate names across environments without losing connection freshness", () => {
    const environments = [
      environment({ environmentId: ENVIRONMENT_A, label: "Laptop" }),
      environment({
        environmentId: ENVIRONMENT_B,
        label: "Desktop",
        connectionState: AVAILABLE_CONNECTION_STATE,
        shellStatus: "cached",
      }),
      environment({
        environmentId: ENVIRONMENT_C,
        label: "Remote",
        connectionState: CONNECTING,
        shellStatus: "synchronizing",
      }),
    ];
    const harness = makeDependencies({ readEnvironments: () => environments });
    const repository = createVoiceSupervisorRepository(harness.dependencies);

    const projects = repository.listProjects();
    const threads = repository.listThreads();

    expect(projects).toHaveLength(3);
    expect(projects.map((record) => record.project.title)).toEqual([
      "Shared project",
      "Shared project",
      "Shared project",
    ]);
    expect(projects.map((record) => record.project.environmentId)).toEqual([
      ENVIRONMENT_A,
      ENVIRONMENT_B,
      ENVIRONMENT_C,
    ]);
    expect(projects.map((record) => record.availability)).toEqual([
      "live",
      "disconnected",
      "stale",
    ]);
    expect(projects.map((record) => record.aliases)).toEqual([
      ["Shared project"],
      ["Shared project"],
      ["Shared project"],
    ]);
    expect(projects.map((record) => record.displayLabel)).toEqual([
      "Shared project · Laptop",
      "Shared project · Desktop",
      "Shared project · Remote",
    ]);
    expect(threads.map((record) => record.displayLabel)).toEqual([
      "Shared thread · Laptop",
      "Shared thread · Desktop",
      "Shared thread · Remote",
    ]);
    expect(threads.map((record) => record.availability)).toEqual(["live", "disconnected", "stale"]);
    expect(repository.getProject(ENVIRONMENT_B, PROJECT_ID)?.project.environmentId).toBe(
      ENVIRONMENT_B,
    );
    expect(repository.getThread(ENVIRONMENT_C, THREAD_ID)?.thread.environmentId).toBe(
      ENVIRONMENT_C,
    );
  });

  it("revalidates live snapshots and versions only the changed target", () => {
    let environments = [
      environment({
        environmentId: ENVIRONMENT_A,
        label: "Laptop",
        snapshotSequence: 1,
      }),
    ];
    const harness = makeDependencies({ readEnvironments: () => environments });
    const repository = createVoiceSupervisorRepository(harness.dependencies);
    const firstProjectVersion = repository.getProject(ENVIRONMENT_A, PROJECT_ID)?.version;
    const firstThreadVersion = repository.getThread(ENVIRONMENT_A, THREAD_ID)?.version;

    environments = [
      environment({
        environmentId: ENVIRONMENT_A,
        label: "Laptop",
        snapshotSequence: 9,
      }),
    ];
    expect(repository.getProject(ENVIRONMENT_A, PROJECT_ID)?.version).toBe(firstProjectVersion);
    expect(repository.getThread(ENVIRONMENT_A, THREAD_ID)?.version).toBe(firstThreadVersion);

    environments = [
      environment({
        environmentId: ENVIRONMENT_A,
        label: "Laptop",
        snapshotSequence: 10,
        projects: [project({ updatedAt: LATER })],
        threads: [thread({ updatedAt: LATER })],
      }),
    ];
    expect(repository.getProject(ENVIRONMENT_A, PROJECT_ID)?.version).not.toBe(firstProjectVersion);
    expect(repository.getThread(ENVIRONMENT_A, THREAD_ID)?.version).not.toBe(firstThreadVersion);

    environments = [
      environment({
        environmentId: ENVIRONMENT_A,
        label: "Laptop",
        connectionState: AVAILABLE_CONNECTION_STATE,
        shellStatus: "cached",
        projects: [project({ updatedAt: LATER })],
        threads: [thread({ updatedAt: LATER })],
      }),
    ];
    expect(repository.getProject(ENVIRONMENT_A, PROJECT_ID)?.availability).toBe("disconnected");
    expect(repository.getThread(ENVIRONMENT_A, THREAD_ID)?.availability).toBe("disconnected");

    environments = [];
    expect(repository.getProject(ENVIRONMENT_A, PROJECT_ID)).toBeNull();
    expect(repository.getThread(ENVIRONMENT_A, THREAD_ID)).toBeNull();
  });

  it("prepares a local start from resolved T3 defaults and generates metadata once", async () => {
    const instruction = `Implement the voice supervisor ${"carefully ".repeat(8)}`;
    const defaults: VoiceSupervisorStartThreadDefaults = {
      modelSelection: MODEL_SELECTION,
      workspace: {
        mode: "local",
        branch: "feature/current-checkout",
        worktreePath: "/workspace/current-checkout",
      },
    };
    const harness = makeDependencies({
      readEnvironments: () => [environment({ environmentId: ENVIRONMENT_A, label: "Laptop" })],
      defaults,
    });
    const repository = createVoiceSupervisorRepository(harness.dependencies);
    const target = firstProject(repository);

    const prepared = await repository.prepareStartThread({
      project: target,
      instruction,
    });

    expect(prepared).toEqual({
      commandId: CommandId.make("command-generated"),
      messageId: MessageId.make("message-generated"),
      threadId: ThreadId.make("thread-generated"),
      createdAt: NOW,
      title: truncate(instruction),
      titleSeed: truncate(instruction),
      modelSelection: MODEL_SELECTION,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspace: defaults.workspace,
    });
    expect(harness.resolveStartThreadDefaults).toHaveBeenCalledExactlyOnceWith({
      project: target.project,
    });
    expect(harness.makeCommandId).toHaveBeenCalledTimes(1);
    expect(harness.makeMessageId).toHaveBeenCalledTimes(1);
    expect(harness.makeThreadId).toHaveBeenCalledTimes(1);
    expect(harness.now).toHaveBeenCalledTimes(1);
    expect(harness.randomHex).not.toHaveBeenCalled();
    expect(harness.formatTitle).toHaveBeenCalledExactlyOnceWith(instruction);

    const command = buildStartProjectTaskInput({
      ...prepared,
      projectId: target.project.id,
      text: instruction,
      attachments: [],
    });
    expect(command.bootstrap).toEqual({
      createThread: {
        projectId: PROJECT_ID,
        title: truncate(instruction),
        modelSelection: MODEL_SELECTION,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "feature/current-checkout",
        worktreePath: "/workspace/current-checkout",
        createdAt: NOW,
      },
    });
  });

  it("prepares canonical worktree setup without inventing a workspace path or model", async () => {
    const defaults: VoiceSupervisorStartThreadDefaults = {
      modelSelection: MODEL_SELECTION,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      workspace: {
        mode: "worktree",
        baseBranch: "release",
        startFromOrigin: true,
      },
    };
    const harness = makeDependencies({
      readEnvironments: () => [environment({ environmentId: ENVIRONMENT_A, label: "Laptop" })],
      defaults,
    });
    const repository = createVoiceSupervisorRepository(harness.dependencies);
    const target = firstProject(repository);
    const prepared = await repository.prepareStartThread({
      project: target,
      instruction: "Create the worktree task",
      requestedTitle: "Voice worktree",
    });

    expect(prepared).toMatchObject({
      title: "Voice worktree",
      titleSeed: "Voice worktree",
      modelSelection: MODEL_SELECTION,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      workspace: {
        mode: "worktree",
        projectCwd: "/workspace/shared",
        baseBranch: "release",
        worktreeBranch: buildTemporaryWorktreeBranchName(() => "deadbeef"),
        startFromOrigin: true,
      },
    });
    expect(harness.randomHex).toHaveBeenCalledExactlyOnceWith(4);

    const command = buildStartProjectTaskInput({
      ...prepared,
      projectId: target.project.id,
      text: "Create the worktree task",
      attachments: [],
    });
    expect(command.bootstrap).toEqual({
      createThread: {
        projectId: PROJECT_ID,
        title: "Voice worktree",
        modelSelection: MODEL_SELECTION,
        runtimeMode: "approval-required",
        interactionMode: "plan",
        branch: "release",
        worktreePath: null,
        createdAt: NOW,
      },
      prepareWorktree: {
        projectCwd: "/workspace/shared",
        baseBranch: "release",
        branch: "t3code/deadbeef",
        startFromOrigin: true,
      },
      runSetupScript: true,
    });
  });

  it("opens and executes against the exact environment with accepted receipts", async () => {
    const harness = makeDependencies({
      readEnvironments: () => [environment({ environmentId: ENVIRONMENT_B, label: "Desktop" })],
    });
    const repository = createVoiceSupervisorRepository(harness.dependencies);
    const target = firstThread(repository);

    await repository.openThread(target);
    expect(harness.openThread).toHaveBeenCalledExactlyOnceWith({
      environmentId: ENVIRONMENT_B,
      threadId: THREAD_ID,
    });

    const followUpPreparation = await repository.prepareFollowUp({
      thread: target,
      instruction: "Continue the review",
    });
    const followUp = buildFollowUpThreadInput({
      ...followUpPreparation,
      thread: target.thread,
      text: "Continue the review",
      attachments: [],
    });
    await expect(
      repository.startThreadTurn({ environmentId: ENVIRONMENT_B, command: followUp }),
    ).resolves.toEqual({ status: "accepted" });
    expect(harness.startThreadTurn).toHaveBeenCalledExactlyOnceWith({
      environmentId: ENVIRONMENT_B,
      input: followUp,
    });

    const interruptPreparation = await repository.prepareInterrupt({ thread: target });
    const interrupt = buildThreadTurnInterruptInput({
      ...interruptPreparation,
      thread: target.thread,
    });
    await expect(
      repository.interruptThreadTurn({ environmentId: ENVIRONMENT_B, command: interrupt }),
    ).resolves.toEqual({ status: "accepted" });
    expect(harness.interruptThreadTurn).toHaveBeenCalledExactlyOnceWith({
      environmentId: ENVIRONMENT_B,
      input: interrupt,
    });
    expect(harness.makeCommandId).toHaveBeenCalledTimes(2);
    expect(harness.makeMessageId).toHaveBeenCalledTimes(1);
    expect(harness.now).toHaveBeenCalledTimes(2);
  });

  it("surfaces receipt-backed command failures without claiming acceptance", async () => {
    const dispatchFailure = new Error("Server rejected command");
    const harness = makeDependencies({
      readEnvironments: () => [environment({ environmentId: ENVIRONMENT_A, label: "Laptop" })],
    });
    harness.startThreadTurn.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(dispatchFailure)));
    const repository = createVoiceSupervisorRepository(harness.dependencies);
    const target = firstProject(repository);
    const prepared = await repository.prepareStartThread({
      project: target,
      instruction: "Start safely",
    });
    const command = buildStartProjectTaskInput({
      ...prepared,
      projectId: target.project.id,
      text: "Start safely",
      attachments: [],
    });

    await expect(
      repository.startThreadTurn({ environmentId: ENVIRONMENT_A, command }),
    ).rejects.toBe(dispatchFailure);
  });
});
