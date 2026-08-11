import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Schema from "effect/Schema";

import type {
  BuiltFollowUpThreadInput,
  BuiltInterruptThreadInput,
  BuiltStartProjectTaskInput,
} from "./threadTasks.ts";
import {
  createThreadSupervisorCore,
  makeSupervisorTargetVersion,
  type SupervisorProposalHandle,
} from "./threadSupervisor.ts";

import {
  MAX_VOICE_TOOL_CALL_ID_CHARS,
  MAX_VOICE_TOOL_INSTRUCTION_CHARS,
  MAX_VOICE_TOOL_LIST_ITEMS,
  MAX_VOICE_TOOL_SELECTOR_CHARS,
  MAX_VOICE_TOOL_TITLE_CHARS,
  MAX_VOICE_TARGET_LABEL_CHARS,
  buildVoiceTargetDisplayLabel,
  createVoiceToolsController,
  voiceSupervisorToolDefinitions,
  type VoiceSupervisorProjectRecord,
  type VoiceSupervisorRepository,
  type VoiceSupervisorThreadRecord,
  type VoiceMutationResult,
} from "./voiceSupervisorTools.ts";

const NOW = "2026-08-10T12:00:00.000Z";
const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("codex-default"),
  model: "gpt-5",
};

const PreviewResult = Schema.Struct({
  operation: Schema.String,
  instruction: Schema.optionalKey(Schema.String),
  target: Schema.String,
  title: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  runtimeMode: Schema.optionalKey(Schema.String),
  interactionMode: Schema.optionalKey(Schema.String),
  workspace: Schema.optionalKey(
    Schema.Struct({
      mode: Schema.String,
      baseBranch: Schema.optionalKey(Schema.String),
      startFromOrigin: Schema.optionalKey(Schema.Boolean),
      branch: Schema.optionalKey(Schema.NullOr(Schema.String)),
      hasWorktreePath: Schema.optionalKey(Schema.Boolean),
      runSetupScript: Schema.Boolean,
    }),
  ),
});
const decodePreview = Schema.decodeUnknownSync(PreviewResult);

function projectRecord(input: {
  environmentId: string;
  projectId: string;
  title: string;
  environmentLabel?: string;
  version?: string;
  availability?: VoiceSupervisorProjectRecord["availability"];
  aliases?: ReadonlyArray<string>;
}): VoiceSupervisorProjectRecord {
  return {
    project: {
      environmentId: EnvironmentId.make(input.environmentId),
      id: ProjectId.make(input.projectId),
      title: input.title,
      workspaceRoot: `/secret/${input.environmentId}/${input.projectId}`,
      repositoryIdentity: null,
      defaultModelSelection: MODEL_SELECTION,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
    displayLabel: buildVoiceTargetDisplayLabel(
      input.title,
      input.environmentLabel ?? "Test environment",
    ),
    version: makeSupervisorTargetVersion(input.version ?? "1"),
    availability: input.availability ?? "live",
    aliases: input.aliases ?? [input.title],
  };
}

function threadRecord(input: {
  environmentId: string;
  projectId: string;
  threadId: string;
  title: string;
  environmentLabel?: string;
  version?: string;
  availability?: VoiceSupervisorThreadRecord["availability"];
  running?: boolean;
  currentStep?: string;
  updatedAt?: string;
  aliases?: ReadonlyArray<string>;
}): VoiceSupervisorThreadRecord {
  const threadId = ThreadId.make(input.threadId);
  const running = input.running ?? false;
  return {
    thread: {
      environmentId: EnvironmentId.make(input.environmentId),
      id: threadId,
      projectId: ProjectId.make(input.projectId),
      title: input.title,
      modelSelection: MODEL_SELECTION,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: null,
      latestTurn: running
        ? {
            turnId: TurnId.make(`turn-${input.threadId}`),
            state: "running",
            requestedAt: NOW,
            startedAt: NOW,
            completedAt: null,
            assistantMessageId: null,
          }
        : null,
      createdAt: NOW,
      updatedAt: input.updatedAt ?? NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      session: running
        ? {
            threadId,
            status: "running",
            providerName: "Codex",
            runtimeMode: "full-access",
            activeTurnId: TurnId.make(`turn-${input.threadId}`),
            lastError: null,
            updatedAt: NOW,
          }
        : null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      ...(input.currentStep === undefined
        ? {}
        : { planProgress: { step: input.currentStep, completedSteps: 1, totalSteps: 3 } }),
    },
    displayLabel: buildVoiceTargetDisplayLabel(
      input.title,
      input.environmentLabel ?? "Test environment",
    ),
    version: makeSupervisorTargetVersion(input.version ?? "1"),
    availability: input.availability ?? "live",
    aliases: input.aliases ?? [input.title],
  };
}

function makeHarness(input: {
  projects: Array<VoiceSupervisorProjectRecord>;
  threads: Array<VoiceSupervisorThreadRecord>;
  maxToolCalls?: number;
}) {
  let opaqueSequence = 0;
  let metadataSequence = 0;
  const opened: VoiceSupervisorThreadRecord[] = [];
  const started: Array<{
    readonly environmentId: EnvironmentId;
    readonly command: BuiltStartProjectTaskInput | BuiltFollowUpThreadInput;
  }> = [];
  const interrupted: Array<{
    readonly environmentId: EnvironmentId;
    readonly command: BuiltInterruptThreadInput;
  }> = [];
  const startPreparation = {
    commandId: CommandId.make("command-start"),
    messageId: MessageId.make("message-start"),
    createdAt: NOW,
    threadId: ThreadId.make("thread-created"),
    title: "Voice task",
    titleSeed: "Voice task",
    modelSelection: MODEL_SELECTION,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    workspace: {
      mode: "worktree" as const,
      projectCwd: "/secret/workspace",
      baseBranch: "main",
      worktreeBranch: "voice/task",
      startFromOrigin: true,
    },
  };
  const repository = {
    listProjects: vi.fn(async () => input.projects),
    listThreads: vi.fn(async () => input.threads),
    getProject: vi.fn(
      async (environmentId: EnvironmentId, projectId: ProjectId) =>
        input.projects.find(
          (record) =>
            record.project.environmentId === environmentId && record.project.id === projectId,
        ) ?? null,
    ),
    getThread: vi.fn(
      async (environmentId: EnvironmentId, threadId: ThreadId) =>
        input.threads.find(
          (record) =>
            record.thread.environmentId === environmentId && record.thread.id === threadId,
        ) ?? null,
    ),
    prepareStartThread: vi.fn(async () => startPreparation),
    prepareFollowUp: vi.fn(async () => {
      metadataSequence += 1;
      return {
        commandId: CommandId.make(`command-follow-${metadataSequence}`),
        messageId: MessageId.make(`message-follow-${metadataSequence}`),
        createdAt: NOW,
      };
    }),
    prepareInterrupt: vi.fn(async () => {
      metadataSequence += 1;
      return {
        commandId: CommandId.make(`command-interrupt-${metadataSequence}`),
        createdAt: NOW,
      };
    }),
    openThread: vi.fn(async (thread: VoiceSupervisorThreadRecord) => {
      opened.push(thread);
    }),
    startThreadTurn: vi.fn(async (dispatch) => {
      started.push(dispatch);
      return { status: "accepted" as const };
    }),
    interruptThreadTurn: vi.fn(async (dispatch) => {
      interrupted.push(dispatch);
      return { status: "completed" as const };
    }),
  } satisfies VoiceSupervisorRepository;
  const core = createThreadSupervisorCore({
    now: () => 1_000,
    makeOpaqueId: (kind) => `${kind}-voice-${++opaqueSequence}`,
  });
  return {
    controller: createVoiceToolsController({
      core,
      repository,
      ...(input.maxToolCalls === undefined ? {} : { maxToolCalls: input.maxToolCalls }),
    }),
    repository,
    opened,
    started,
    interrupted,
    startPreparation,
  };
}

function proposalHandle(result: VoiceMutationResult): SupervisorProposalHandle {
  if (result.status !== "proposed") {
    throw new Error(`Expected proposed result, received ${result.status}.`);
  }
  return result.proposal.handle;
}

describe("voice supervisor tool allowlist", () => {
  it("exports exactly the eight bounded tools and strictly rejects excess arguments", async () => {
    expect(voiceSupervisorToolDefinitions.map((tool) => tool.name)).toEqual([
      "list_active_work",
      "list_projects",
      "list_threads",
      "get_thread_summary",
      "open_thread",
      "start_thread",
      "send_follow_up",
      "interrupt_thread",
    ]);
    expect(
      voiceSupervisorToolDefinitions.some((tool) =>
        /approval|user.input|delete|archive|terminal/i.test(tool.name),
      ),
    ).toBe(false);
    expect(
      JSON.stringify(voiceSupervisorToolDefinitions.map((tool) => tool.parameters)),
    ).not.toContain("call_id");
    expect(voiceSupervisorToolDefinitions.map((tool) => tool.parameters)).toEqual([
      {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 0, maximum: MAX_VOICE_TOOL_LIST_ITEMS },
        },
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 0, maximum: MAX_VOICE_TOOL_LIST_ITEMS },
        },
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 0, maximum: MAX_VOICE_TOOL_LIST_ITEMS },
        },
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          thread: { type: "string", minLength: 1, maxLength: MAX_VOICE_TOOL_SELECTOR_CHARS },
        },
        required: ["thread"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          thread: { type: "string", minLength: 1, maxLength: MAX_VOICE_TOOL_SELECTOR_CHARS },
        },
        required: ["thread"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          project_handle: {
            type: "string",
            minLength: 1,
            maxLength: MAX_VOICE_TOOL_SELECTOR_CHARS,
          },
          instruction: {
            type: "string",
            minLength: 1,
            maxLength: MAX_VOICE_TOOL_INSTRUCTION_CHARS,
          },
          title: { type: "string", minLength: 1, maxLength: MAX_VOICE_TOOL_TITLE_CHARS },
        },
        required: ["project_handle", "instruction"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          thread_handle: {
            type: "string",
            minLength: 1,
            maxLength: MAX_VOICE_TOOL_SELECTOR_CHARS,
          },
          instruction: {
            type: "string",
            minLength: 1,
            maxLength: MAX_VOICE_TOOL_INSTRUCTION_CHARS,
          },
        },
        required: ["thread_handle", "instruction"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          thread_handle: {
            type: "string",
            minLength: 1,
            maxLength: MAX_VOICE_TOOL_SELECTOR_CHARS,
          },
        },
        required: ["thread_handle"],
        additionalProperties: false,
      },
    ]);

    const harness = makeHarness({ projects: [], threads: [] });
    const invalidInput = { call_id: "strict-call", extra: true };
    await expect(harness.controller.invoke("list_projects", invalidInput)).resolves.toEqual({
      status: "invalid-arguments",
    });
    await expect(harness.controller.invoke("list_projects", invalidInput)).resolves.toEqual({
      status: "call-id-conflict",
    });
    await expect(
      harness.controller.invoke("list_projects", { call_id: "strict-call" }),
    ).resolves.toEqual({ status: "call-id-conflict" });
    expect(harness.repository.listProjects).not.toHaveBeenCalled();

    const getter = vi.fn(() => true);
    const accessorInput = { call_id: "accessor-call" };
    Object.defineProperty(accessorInput, "extra", { enumerable: true, get: getter });
    await expect(harness.controller.invoke("list_projects", accessorInput)).resolves.toEqual({
      status: "invalid-arguments",
    });
    await expect(harness.controller.invoke("list_projects", accessorInput)).resolves.toEqual({
      status: "call-id-conflict",
    });
    expect(getter).not.toHaveBeenCalled();

    const getTrap = vi.fn(() => {
      throw new Error("property get trap must not run");
    });
    const proxiedInput = new Proxy({ call_id: "proxy-call", extra: true }, { get: getTrap });
    await expect(harness.controller.invoke("list_projects", proxiedInput)).resolves.toEqual({
      status: "invalid-arguments",
    });
    expect(getTrap).not.toHaveBeenCalled();

    const ownKeysTrap = vi.fn((): never => {
      throw new Error("structural proxy trap");
    });
    const throwingProxy = new Proxy({ call_id: "throwing-proxy-call" }, { ownKeys: ownKeysTrap });
    await expect(harness.controller.invoke("list_projects", throwingProxy)).resolves.toEqual({
      status: "invalid-arguments",
    });
    await expect(harness.controller.invoke("list_projects", throwingProxy)).resolves.toEqual({
      status: "call-id-conflict",
    });
    expect(ownKeysTrap).toHaveBeenCalledTimes(1);

    await expect(harness.controller.invoke("delete_thread", { call_id: "nope" })).resolves.toEqual({
      status: "unknown-tool",
    });
  });

  it("fails closed at the call ledger cap while retaining authoritative replays", async () => {
    const harness = makeHarness({ projects: [], threads: [], maxToolCalls: 1 });
    const firstInput = { call_id: "first-call" };
    const first = await harness.controller.invoke("list_projects", firstInput);
    expect(first.status).toBe("ok");
    expect(await harness.controller.invoke("list_projects", firstInput)).toBe(first);
    await expect(
      harness.controller.invoke("list_projects", { call_id: "first-call", limit: 1 }),
    ).resolves.toEqual({ status: "call-id-conflict" });

    const capacity = await harness.controller.invoke("list_projects", {
      call_id: "second-call",
    });
    expect(capacity).toEqual({ status: "capacity-exceeded", resource: "calls" });
    expect(await harness.controller.invoke("list_projects", { call_id: "second-call" })).toBe(
      capacity,
    );
    expect(harness.repository.listProjects).toHaveBeenCalledTimes(1);
  });

  it("binds decoding to the initially extracted call id across proxy descriptor changes", async () => {
    const harness = makeHarness({ projects: [], threads: [] });
    let descriptorCalls = 0;
    const descriptorTrap = vi.fn(
      (target: { call_id: string }, property: string | symbol): PropertyDescriptor | undefined => {
        if (property !== "call_id") return Reflect.getOwnPropertyDescriptor(target, property);
        descriptorCalls += 1;
        return {
          value: descriptorCalls % 2 === 1 ? "shift-a" : "shift-b",
          enumerable: true,
          configurable: true,
          writable: true,
        };
      },
    );
    const ownKeysTrap = vi.fn((target: { call_id: string }) => Reflect.ownKeys(target));
    const shiftingInput = new Proxy(
      { call_id: "ignored-by-proxy" },
      { getOwnPropertyDescriptor: descriptorTrap, ownKeys: ownKeysTrap },
    );

    await expect(harness.controller.invoke("list_projects", shiftingInput)).resolves.toEqual({
      status: "invalid-arguments",
    });
    await expect(harness.controller.invoke("list_projects", shiftingInput)).resolves.toEqual({
      status: "call-id-conflict",
    });
    expect(descriptorTrap).toHaveBeenCalledTimes(3);
    expect(ownKeysTrap).toHaveBeenCalledTimes(1);

    const normalB = { call_id: "shift-b" };
    const executed = await harness.controller.invoke("list_projects", normalB);
    expect(executed.status).toBe("ok");
    expect(await harness.controller.invoke("list_projects", normalB)).toBe(executed);
    expect(harness.repository.listProjects).toHaveBeenCalledTimes(1);
  });

  it("rejects representative numeric and string bound violations before adapters run", async () => {
    const harness = makeHarness({ projects: [], threads: [] });
    await expect(
      harness.controller.invoke("list_threads", { call_id: "limit-call", limit: 21 }),
    ).resolves.toEqual({ status: "invalid-arguments" });
    await expect(
      harness.controller.invoke("list_threads", { call_id: "limit-call", limit: 20 }),
    ).resolves.toEqual({ status: "call-id-conflict" });
    await expect(
      harness.controller.invoke("list_threads", { call_id: "fractional-limit", limit: 1.5 }),
    ).resolves.toEqual({ status: "invalid-arguments" });
    await expect(
      harness.controller.invoke("get_thread_summary", {
        call_id: "selector-bound",
        thread: "x".repeat(513),
      }),
    ).resolves.toEqual({ status: "invalid-arguments" });
    await expect(
      harness.controller.invoke("start_thread", {
        call_id: "instruction-bound",
        project_handle: "opaque-project",
        instruction: "x".repeat(4_001),
      }),
    ).resolves.toEqual({ status: "invalid-arguments" });
    await expect(
      harness.controller.invoke("start_thread", {
        call_id: "title-bound",
        project_handle: "opaque-project",
        instruction: "bounded",
        title: "x".repeat(73),
      }),
    ).resolves.toEqual({ status: "invalid-arguments" });
    await expect(
      harness.controller.invoke("list_projects", {
        call_id: "x".repeat(MAX_VOICE_TOOL_CALL_ID_CHARS + 1),
      }),
    ).resolves.toEqual({ status: "invalid-arguments" });
    expect(harness.repository.listProjects).not.toHaveBeenCalled();
    expect(harness.repository.listThreads).not.toHaveBeenCalled();
  });
});

describe("voice supervisor reads and navigation", () => {
  it("reserves bounded display-label space for each environment qualifier", async () => {
    const sharedTitle = `Shared ${"project ".repeat(80)}`.trimEnd();
    const projects = [
      projectRecord({
        environmentId: "environment-a",
        environmentLabel: "Laptop",
        projectId: "project-a",
        title: sharedTitle,
      }),
      projectRecord({
        environmentId: "environment-b",
        environmentLabel: "Desktop",
        projectId: "project-b",
        title: sharedTitle,
      }),
    ];
    const harness = makeHarness({ projects, threads: [] });
    const result = await harness.controller.invoke("list_projects", {
      call_id: "long-project-labels",
    });
    if (result.status !== "ok") throw new Error("Expected a project list.");

    expect(result.items.map((item) => item.label)).toEqual([
      expect.stringMatching(/ · Laptop$/),
      expect.stringMatching(/ · Desktop$/),
    ]);
    expect(new Set(result.items.map((item) => item.label)).size).toBe(2);
    expect(result.items.every((item) => item.label.length <= MAX_VOICE_TARGET_LABEL_CHARS)).toBe(
      true,
    );

    const longEnvironment = buildVoiceTargetDisplayLabel(
      sharedTitle,
      `Remote environment ${"region ".repeat(40)}Cape Town`,
    );
    expect(longEnvironment.length).toBeLessThanOrEqual(MAX_VOICE_TARGET_LABEL_CHARS);
    expect(longEnvironment).toContain(" · Remote environment");
    expect(longEnvironment).toMatch(/Cape Town$/);
  });

  it("keeps duplicate environments ambiguous, partial names as candidates, and summaries bounded", async () => {
    const longStep = "Review every active worker and summarize progress ".repeat(20);
    const oversizedUpdatedAt = "oversized-updated-at".repeat(1_000);
    const projects = [
      projectRecord({
        environmentId: "environment-a",
        environmentLabel: "Laptop",
        projectId: "project-a",
        title: "T3",
      }),
      projectRecord({
        environmentId: "environment-b",
        environmentLabel: "Desktop",
        projectId: "project-b",
        title: "T3",
      }),
    ];
    const threads = [
      threadRecord({
        environmentId: "environment-a",
        environmentLabel: "Laptop",
        projectId: "project-a",
        threadId: "thread-a",
        title: "Fix voice",
        running: true,
        currentStep: longStep,
        updatedAt: oversizedUpdatedAt,
      }),
      threadRecord({
        environmentId: "environment-b",
        environmentLabel: "Desktop",
        projectId: "project-b",
        threadId: "thread-b",
        title: "Fix voice",
      }),
      threadRecord({
        environmentId: "environment-a",
        environmentLabel: "Laptop",
        projectId: "project-a",
        threadId: "thread-c",
        title: "Voice planning",
      }),
    ];
    const harness = makeHarness({ projects, threads });

    const projectList = await harness.controller.invoke("list_projects", {
      call_id: "projects-list",
    });
    expect(projectList.status).toBe("ok");
    if (projectList.status !== "ok") throw new Error("Expected a project list.");
    expect(projectList.items).toHaveLength(2);
    expect(projectList.items.map((item) => item.label)).toEqual(["T3 · Laptop", "T3 · Desktop"]);
    const threadList = await harness.controller.invoke("list_threads", {
      call_id: "threads-list",
    });
    expect(threadList.status).toBe("ok");
    if (threadList.status !== "ok") throw new Error("Expected a thread list.");
    expect(threadList.items).toHaveLength(3);
    expect(JSON.stringify([projectList, threadList])).not.toContain("environment-a");
    expect(JSON.stringify([projectList, threadList])).not.toContain("thread-a");
    expect(JSON.stringify([projectList, threadList])).not.toContain("/secret/");
    expect(Object.isFrozen(threadList)).toBe(true);
    expect(Object.isFrozen(threadList.items)).toBe(true);
    const firstThread = threadList.items[0];
    if (firstThread === undefined) throw new Error("Expected a published thread handle.");
    expect(Object.isFrozen(firstThread)).toBe(true);
    const firstLabel = firstThread.label;
    expect(Reflect.set(firstThread, "label", "mutated")).toBe(false);
    expect(await harness.controller.invoke("list_threads", { call_id: "threads-list" })).toBe(
      threadList,
    );
    expect(firstThread.label).toBe(firstLabel);

    const ambiguous = await harness.controller.invoke("get_thread_summary", {
      call_id: "duplicate-summary",
      thread: "Fix voice",
    });
    expect(ambiguous).toMatchObject({ status: "ambiguous", candidates: [{}, {}] });
    if (ambiguous.status !== "ambiguous") throw new Error("Expected duplicate raw titles.");
    expect(ambiguous.candidates.map((candidate) => candidate.label)).toEqual([
      "Fix voice · Laptop",
      "Fix voice · Desktop",
    ]);
    await expect(
      harness.controller.invoke("get_thread_summary", {
        call_id: "partial-summary",
        thread: "planning",
      }),
    ).resolves.toMatchObject({ status: "candidates", candidates: [{}] });
    await expect(
      harness.controller.invoke("get_thread_summary", {
        call_id: "qualified-summary",
        thread: "Fix voice · Laptop",
      }),
    ).resolves.toMatchObject({
      status: "ok",
      thread: { label: "Fix voice · Laptop" },
    });

    const summary = await harness.controller.invoke("get_thread_summary", {
      call_id: "bounded-summary",
      thread: firstThread.handle,
    });
    expect(summary.status).toBe("ok");
    if (summary.status !== "ok") throw new Error("Expected a thread summary.");
    expect(summary.thread.operationalStatus).toBe("working");
    expect(summary.thread.currentStep?.length).toBeLessThanOrEqual(240);
    expect(summary.thread.currentStep).toMatch(/\.\.\.$/);
    expect(JSON.stringify(summary)).not.toContain("messages");
    expect(JSON.stringify(summary)).not.toContain(oversizedUpdatedAt);
    expect("updatedAt" in summary.thread).toBe(false);

    const bounded = await harness.controller.invoke("list_threads", {
      call_id: "threads-bounded",
      limit: 1,
    });
    expect(bounded.status).toBe("ok");
    if (bounded.status !== "ok") throw new Error("Expected a bounded thread list.");
    expect(bounded).toMatchObject({ totalCount: 3, omittedCount: 2, truncated: true });

    const openInput = {
      call_id: "open-thread",
      thread: firstThread.handle,
    };
    const opened = await harness.controller.invoke("open_thread", openInput);
    expect(opened).toMatchObject({ status: "opened" });
    expect(await harness.controller.invoke("open_thread", openInput)).toBe(opened);
    expect(harness.opened).toHaveLength(1);

    const active = await harness.controller.invoke("list_active_work", {
      call_id: "active-work",
    });
    expect(active.status).toBe("ok");
    if (active.status !== "ok") throw new Error("Expected an active work list.");
    expect(active.items).toEqual([
      expect.objectContaining({ label: "Fix voice · Laptop", status: "working" }),
    ]);
  });

  it("caps representative repository lists and display strings", async () => {
    const threads = Array.from({ length: 25 }, (_, index) =>
      threadRecord({
        environmentId: "environment-a",
        projectId: "project-a",
        threadId: `thread-${index}`,
        title: index === 0 ? "x".repeat(1_000) : `Thread ${index}`,
      }),
    );
    const harness = makeHarness({ projects: [], threads });
    const result = await harness.controller.invoke("list_threads", { call_id: "large-list" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("Expected a bounded large list.");
    expect(result.items).toHaveLength(20);
    expect(result).toMatchObject({ totalCount: 25, omittedCount: 5, truncated: true });
    expect(result.items[0]?.label.length).toBeLessThanOrEqual(240);
  });
});

describe("voice supervisor confirmed mutations", () => {
  it("routes start, follow-up, and interrupt only after confirmation with frozen exact previews", async () => {
    const projects = [
      projectRecord({
        environmentId: "environment-a",
        environmentLabel: "Laptop",
        projectId: "project-a",
        title: "T3",
      }),
    ];
    const threads = [
      threadRecord({
        environmentId: "environment-a",
        environmentLabel: "Laptop",
        projectId: "project-a",
        threadId: "thread-a",
        title: "Voice implementation",
        running: true,
      }),
    ];
    const harness = makeHarness({ projects, threads });
    const projectList = await harness.controller.invoke("list_projects", {
      call_id: "project-handles",
    });
    if (projectList.status !== "ok" || projectList.items[0] === undefined) {
      throw new Error("Expected a project handle.");
    }
    const projectHandle = projectList.items[0].handle;
    const threadList = await harness.controller.invoke("list_threads", {
      call_id: "thread-handles",
    });
    if (threadList.status !== "ok" || threadList.items[0] === undefined) {
      throw new Error("Expected a thread handle.");
    }
    const threadHandle = threadList.items[0].handle;

    const startInput = {
      call_id: "start-call",
      project_handle: projectHandle,
      instruction: "Implement the voice controller",
      title: "Voice task",
    };
    const startProposal = await harness.controller.invoke("start_thread", startInput);
    expect(harness.started).toHaveLength(0);
    expect(await harness.controller.invoke("start_thread", startInput)).toBe(startProposal);
    expect(Object.isFrozen(startProposal)).toBe(true);
    if (startProposal.status !== "proposed") throw new Error("Expected a start proposal.");
    expect(Object.isFrozen(startProposal.proposal)).toBe(true);
    expect(Object.isFrozen(startProposal.proposal.target)).toBe(true);
    expect(Reflect.set(startProposal.proposal, "summary", "mutated")).toBe(false);
    expect(startProposal.proposal.summary).toBe("Start Voice task in T3 · Laptop");
    await expect(
      harness.controller.invoke("start_thread", {
        ...startInput,
        instruction: "Changed instruction",
      }),
    ).resolves.toEqual({ status: "call-id-conflict" });
    const startHandle = startProposal.proposal.handle;
    const localStart = harness.controller.getConfirmationPayloadLocally(startHandle);
    expect(localStart.status).toBe("pending");
    if (localStart.status !== "pending") return;
    const startPreview = decodePreview(localStart.payload.preview);
    expect(startPreview).toEqual({
      operation: "start_thread",
      instruction: "Implement the voice controller",
      target: "T3 · Laptop",
      title: "Voice task",
      model: "gpt-5",
      runtimeMode: "full-access",
      interactionMode: "default",
      workspace: {
        mode: "worktree",
        baseBranch: "main",
        startFromOrigin: true,
        runSetupScript: true,
      },
    });
    expect(Object.isFrozen(localStart.payload.preview)).toBe(true);
    expect(Object.isFrozen(localStart.payload.target)).toBe(true);
    if (localStart.payload.preview === null || typeof localStart.payload.preview !== "object") {
      throw new Error("Expected an object confirmation preview.");
    }
    const workspaceDescriptor = Object.getOwnPropertyDescriptor(
      localStart.payload.preview,
      "workspace",
    );
    expect(workspaceDescriptor).toBeDefined();
    expect(Object.isFrozen(workspaceDescriptor?.value)).toBe(true);
    harness.startPreparation.title = "Mutated after proposal";

    await expect(harness.controller.confirmProposalLocally(startHandle)).resolves.toMatchObject({
      status: "executed",
      value: { operation: "start_thread", receipt: "accepted" },
    });
    expect(harness.started).toHaveLength(1);
    expect(harness.started[0]).toEqual({
      environmentId: "environment-a",
      command: {
        commandId: "command-start",
        threadId: "thread-created",
        message: {
          messageId: "message-start",
          role: "user",
          text: "Implement the voice controller",
          attachments: [],
        },
        modelSelection: MODEL_SELECTION,
        titleSeed: "Voice task",
        runtimeMode: "full-access",
        interactionMode: "default",
        bootstrap: {
          createThread: {
            projectId: "project-a",
            title: "Voice task",
            modelSelection: MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "main",
            worktreePath: null,
            createdAt: NOW,
          },
          prepareWorktree: {
            projectCwd: "/secret/workspace",
            baseBranch: "main",
            branch: "voice/task",
            startFromOrigin: true,
          },
          runSetupScript: true,
        },
        createdAt: NOW,
      },
    });

    const followProposal = await harness.controller.invoke("send_follow_up", {
      call_id: "follow-call",
      thread_handle: threadHandle,
      instruction: "Continue with the focused tests",
    });
    expect(harness.started).toHaveLength(1);
    const localFollow = harness.controller.getConfirmationPayloadLocally(
      proposalHandle(followProposal),
    );
    expect(localFollow).toMatchObject({
      status: "pending",
      payload: { preview: { target: "Voice implementation · Laptop" } },
    });
    await expect(
      harness.controller.confirmProposalLocally(proposalHandle(followProposal)),
    ).resolves.toMatchObject({ status: "executed", value: { operation: "send_follow_up" } });
    expect(harness.started[1]?.command).toMatchObject({
      threadId: "thread-a",
      message: { text: "Continue with the focused tests", attachments: [] },
      modelSelection: MODEL_SELECTION,
      runtimeMode: "full-access",
      interactionMode: "default",
    });
    const followDispatch = harness.started[1];
    if (followDispatch === undefined) throw new Error("Expected a follow-up dispatch.");
    expect("bootstrap" in followDispatch.command).toBe(false);

    const interruptProposal = await harness.controller.invoke("interrupt_thread", {
      call_id: "interrupt-call",
      thread_handle: threadHandle,
    });
    expect(harness.interrupted).toHaveLength(0);
    const localInterrupt = harness.controller.getConfirmationPayloadLocally(
      proposalHandle(interruptProposal),
    );
    expect(localInterrupt).toMatchObject({
      status: "pending",
      payload: { preview: { target: "Voice implementation · Laptop" } },
    });
    await expect(
      harness.controller.confirmProposalLocally(proposalHandle(interruptProposal)),
    ).resolves.toMatchObject({ status: "executed", value: { operation: "interrupt_thread" } });
    expect(harness.interrupted).toEqual([
      {
        environmentId: "environment-a",
        command: {
          commandId: "command-interrupt-2",
          threadId: "thread-a",
          turnId: "turn-thread-a",
          createdAt: NOW,
        },
      },
    ]);
  });

  it("rejects unavailable targets and revalidates the exact version before dispatch", async () => {
    const projects = [
      projectRecord({
        environmentId: "environment-a",
        projectId: "project-a",
        title: "Disconnected",
        availability: "disconnected",
      }),
    ];
    const threads = [
      threadRecord({
        environmentId: "environment-a",
        projectId: "project-a",
        threadId: "thread-a",
        title: "Stale thread",
        availability: "stale",
      }),
    ];
    const unavailable = makeHarness({ projects, threads });
    const projectList = await unavailable.controller.invoke("list_projects", {
      call_id: "unavailable-projects",
    });
    if (projectList.status !== "ok" || projectList.items[0] === undefined) {
      throw new Error("Expected an unavailable project handle.");
    }
    const projectHandle = projectList.items[0].handle;
    const threadList = await unavailable.controller.invoke("list_threads", {
      call_id: "unavailable-threads",
    });
    if (threadList.status !== "ok" || threadList.items[0] === undefined) {
      throw new Error("Expected an unavailable thread handle.");
    }
    const threadHandle = threadList.items[0].handle;
    await expect(
      unavailable.controller.invoke("start_thread", {
        call_id: "unavailable-start",
        project_handle: projectHandle,
        instruction: "Do not dispatch",
      }),
    ).resolves.toEqual({ status: "target-unavailable", availability: "disconnected" });
    await expect(
      unavailable.controller.invoke("send_follow_up", {
        call_id: "unavailable-follow",
        thread_handle: threadHandle,
        instruction: "Do not dispatch",
      }),
    ).resolves.toEqual({ status: "target-unavailable", availability: "stale" });
    expect(unavailable.started).toHaveLength(0);

    const liveProjects = [
      projectRecord({ environmentId: "environment-b", projectId: "project-b", title: "T3" }),
    ];
    const liveThreads = [
      threadRecord({
        environmentId: "environment-b",
        projectId: "project-b",
        threadId: "thread-b",
        title: "Versioned thread",
        version: "1",
      }),
    ];
    const live = makeHarness({ projects: liveProjects, threads: liveThreads });
    const liveList = await live.controller.invoke("list_threads", {
      call_id: "versioned-threads",
    });
    if (liveList.status !== "ok" || liveList.items[0] === undefined) {
      throw new Error("Expected a live thread handle.");
    }
    const liveHandle = liveList.items[0].handle;
    const proposal = await live.controller.invoke("send_follow_up", {
      call_id: "versioned-follow",
      thread_handle: liveHandle,
      instruction: "Continue only if unchanged",
    });
    liveThreads[0] = threadRecord({
      environmentId: "environment-b",
      projectId: "project-b",
      threadId: "thread-b",
      title: "Versioned thread",
      version: "2",
    });
    await expect(live.controller.confirmProposalLocally(proposalHandle(proposal))).resolves.toEqual(
      { status: "target-rejected", reason: "version-changed" },
    );
    expect(live.started).toHaveLength(0);

    const connectedThreads = [
      threadRecord({
        environmentId: "environment-c",
        projectId: "project-c",
        threadId: "thread-c",
        title: "Connection-bound thread",
      }),
    ];
    const connectionBound = makeHarness({
      projects: [
        projectRecord({ environmentId: "environment-c", projectId: "project-c", title: "T3" }),
      ],
      threads: connectedThreads,
    });
    const connectionList = await connectionBound.controller.invoke("list_threads", {
      call_id: "connection-threads",
    });
    if (connectionList.status !== "ok" || connectionList.items[0] === undefined) {
      throw new Error("Expected a connection-bound thread handle.");
    }
    const connectionHandle = connectionList.items[0].handle;
    const connectionProposal = await connectionBound.controller.invoke("send_follow_up", {
      call_id: "connection-follow",
      thread_handle: connectionHandle,
      instruction: "Continue only while connected",
    });
    const connectedThread = connectedThreads[0];
    if (connectedThread === undefined) throw new Error("Expected a connected thread record.");
    connectedThreads[0] = {
      ...connectedThread,
      availability: "disconnected",
    };
    await expect(
      connectionBound.controller.confirmProposalLocally(proposalHandle(connectionProposal)),
    ).resolves.toEqual({ status: "target-rejected", reason: "disconnected" });
    expect(connectionBound.started).toHaveLength(0);
  });
});
