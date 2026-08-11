import {
  AVAILABLE_CONNECTION_STATE,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
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
import { truncate } from "@t3tools/shared/String";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";

import {
  createVoiceToolsWebRepository,
  type VoiceToolsWebEnvironment,
  type VoiceToolsWebRepositoryDependencies,
} from "./voiceToolsRepository";

const NOW = "2026-08-10T12:00:00.000Z";
const ENVIRONMENT_ID = EnvironmentId.make("environment-web");
const PROJECT_ID = ProjectId.make("project-web");
const THREAD_ID = ThreadId.make("thread-web");
const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("codex-default"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const CONNECTED: SupervisorConnectionState = {
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase: "connected",
  attempt: 1,
  generation: 1,
};

function project(): OrchestrationProjectShell {
  return {
    id: PROJECT_ID,
    title: "Web project",
    workspaceRoot: "/workspace/web",
    repositoryIdentity: null,
    defaultModelSelection: MODEL_SELECTION,
    defaultThreadEnvMode: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function thread(): OrchestrationThreadShell {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Web thread",
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
  };
}

function environment(): VoiceToolsWebEnvironment {
  const snapshot: OrchestrationShellSnapshot = {
    snapshotSequence: 1,
    projects: [project()],
    threads: [thread()],
    updatedAt: NOW,
  };
  const shellState: EnvironmentShellState = {
    snapshot: Option.some(snapshot),
    status: "live",
    error: Option.none(),
  };
  return {
    environmentId: ENVIRONMENT_ID,
    label: "Web environment",
    connectionState: CONNECTED,
    shellState,
  };
}

function firstProject(repository: ReturnType<typeof createVoiceToolsWebRepository>) {
  const record = repository.listProjects()[0];
  if (record === undefined) throw new Error("Expected a project fixture.");
  return record;
}

function firstThread(repository: ReturnType<typeof createVoiceToolsWebRepository>) {
  const record = repository.listThreads()[0];
  if (record === undefined) throw new Error("Expected a thread fixture.");
  return record;
}

describe("createVoiceToolsWebRepository", () => {
  it("preserves web title formatting and TanStack navigation", async () => {
    const navigate = vi.fn<VoiceToolsWebRepositoryDependencies["navigate"]>(async () => undefined);
    const dependencies = {
      readEnvironments: () => [environment()],
      resolveStartThreadDefaults: async () => ({
        modelSelection: MODEL_SELECTION,
        workspace: { mode: "local" as const, branch: "main", worktreePath: null },
      }),
      navigate,
      startThreadTurn: async () => AsyncResult.success({ sequence: 1 }),
      interruptThreadTurn: async () => AsyncResult.success({ sequence: 2 }),
      makeCommandId: () => CommandId.make("command-web"),
      makeMessageId: () => MessageId.make("message-web"),
      makeThreadId: () => ThreadId.make("thread-created-web"),
      now: () => NOW,
      randomHex: () => "deadbeef",
    } satisfies VoiceToolsWebRepositoryDependencies;
    const repository = createVoiceToolsWebRepository(dependencies);
    const instruction = `Keep web behavior ${"exactly ".repeat(10)}`;

    await expect(
      repository.prepareStartThread({ project: firstProject(repository), instruction }),
    ).resolves.toMatchObject({
      commandId: CommandId.make("command-web"),
      messageId: MessageId.make("message-web"),
      threadId: ThreadId.make("thread-created-web"),
      createdAt: NOW,
      title: truncate(instruction),
      titleSeed: truncate(instruction),
    });

    await repository.openThread(firstThread(repository));
    expect(navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId: THREAD_ID },
    });
  });

  it("retains the optional web ID, clock, and random defaults", async () => {
    const dependencies = {
      readEnvironments: () => [environment()],
      resolveStartThreadDefaults: async () => ({
        modelSelection: MODEL_SELECTION,
        workspace: {
          mode: "worktree" as const,
          baseBranch: "main",
          startFromOrigin: true,
        },
      }),
      navigate: async () => undefined,
      startThreadTurn: async () => AsyncResult.success({ sequence: 1 }),
      interruptThreadTurn: async () => AsyncResult.success({ sequence: 2 }),
    } satisfies VoiceToolsWebRepositoryDependencies;
    const repository = createVoiceToolsWebRepository(dependencies);

    const prepared = await repository.prepareStartThread({
      project: firstProject(repository),
      instruction: "Use web defaults",
    });

    expect(prepared.commandId).toMatch(/^[0-9a-f-]{36}$/);
    expect(prepared.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(prepared.threadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(prepared.createdAt))).toBe(false);
    expect(prepared.workspace).toMatchObject({
      mode: "worktree",
      projectCwd: "/workspace/web",
      baseBranch: "main",
      worktreeBranch: expect.stringMatching(/^t3code\/[0-9a-f]{8}$/),
      startFromOrigin: true,
    });
  });
});
