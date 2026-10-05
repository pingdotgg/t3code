import { ProviderInstanceId, ThreadId, type ServerProvider } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import {
  type AgentThread,
  agentToolProperties,
  handoffSettings,
  callerOrigin,
  toolOutcome,
} from "./ProviderDimensions.ts";

const provider = (
  instanceId: string,
  driver: string,
  models: ReadonlyArray<{ slug: string; isCustom: boolean }>,
) =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver,
    models,
  }) as unknown as ServerProvider;

const providers = [
  provider("work-codex", "codex", [{ slug: "gpt-5.5", isCustom: false }]),
  provider("claudeAgent", "claudeAgent", [
    { slug: "claude-opus-5-5", isCustom: false },
    { slug: "my-private-finetune", isCustom: true },
  ]),
  provider("opencode", "opencode", [{ slug: "ollama/acme-internal", isCustom: false }]),
];

const thread = (
  instanceId: string,
  model: string,
  overrides: Partial<AgentThread> = {},
): AgentThread => ({
  modelSelection: { instanceId: ProviderInstanceId.make(instanceId), model },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make("t") },
  ...overrides,
});

it("relates the calling agent to each agent that received work", () => {
  expect(
    agentToolProperties({
      tool: "create_threads",
      providers,
      caller: thread("work-codex", "gpt-5.5", { createdBy: "agent", creationSource: "mcp" }),
      callerDepth: 1,
      targets: [
        thread("claudeAgent", "claude-opus-5-5", { interactionMode: "plan" }),
        thread("work-codex", "gpt-5.5"),
      ],
      outcome: { outcome: "ok" },
      settings: { batchSize: 2, targetChosen: true },
      durationMs: 42,
    }),
  ).toEqual([
    {
      tool: "create_threads",
      callerProvider: "codex",
      callerModel: "gpt-5.5",
      callerOrigin: "agent",
      callerDepth: 1,
      durationMs: 42,
      outcome: "ok",
      batchSize: 2,
      targetChosen: true,
      targetProvider: "claudeAgent",
      targetModel: "claude-opus-5-5",
      targetRuntimeMode: "full-access",
      targetInteractionMode: "plan",
      crossProvider: true,
    },
    {
      tool: "create_threads",
      callerProvider: "codex",
      callerModel: "gpt-5.5",
      callerOrigin: "agent",
      callerDepth: 1,
      durationMs: 42,
      outcome: "ok",
      batchSize: 2,
      targetChosen: true,
      targetProvider: "codex",
      targetModel: "gpt-5.5",
      targetRuntimeMode: "full-access",
      targetInteractionMode: "default",
      crossProvider: false,
    },
  ]);
});

it("reports a non-handoff tool from the credential's provider alone", () => {
  expect(
    agentToolProperties({
      tool: "preview_click",
      providers,
      caller: undefined,
      callerProviderInstanceId: ProviderInstanceId.make("claudeAgent"),
      targets: [],
      outcome: { outcome: "error", errorCode: "capability_denied" },
      durationMs: 3,
    }),
  ).toEqual([
    {
      tool: "preview_click",
      callerProvider: "claudeAgent",
      durationMs: 3,
      outcome: "error",
      errorCode: "capability_denied",
    },
  ]);
});

it("omits custom, user-configured, and unknown models and instance names", () => {
  expect(
    agentToolProperties({
      tool: "t3_thread_send",
      providers,
      caller: thread("claudeAgent", "my-private-finetune"),
      targets: [thread("opencode", "ollama/acme-internal"), thread("removed-instance", "gpt-5.5")],
      outcome: { outcome: "ok" },
    }).map(({ callerProvider, callerModel, targetProvider, targetModel }) => ({
      callerProvider,
      callerModel,
      targetProvider,
      targetModel,
    })),
  ).toEqual([
    {
      callerProvider: "claudeAgent",
      callerModel: undefined,
      targetProvider: "opencode",
      targetModel: undefined,
    },
    {
      callerProvider: "claudeAgent",
      callerModel: undefined,
      targetProvider: "unknown",
      targetModel: undefined,
    },
  ]);
});

it("reads handoff settings from enums and flags, never from prompts or ids", () => {
  expect(
    handoffSettings(
      "delegate_task",
      { task: "secret", mode: "wait", target: { driverKind: "claudeAgent" } },
      { taskId: "t", waitTimedOut: true },
    ),
  ).toEqual({ targetChosen: true, mode: "wait", waitTimedOut: true });
  expect(handoffSettings("delegate_task", { task: "secret" }, { waitTimedOut: false })).toEqual({
    targetChosen: false,
    mode: "async",
  });
  expect(
    handoffSettings(
      "t3_thread_launch",
      { message: "secret", workspaceStrategy: { type: "worktree", branch: "private" } },
      {},
    ),
  ).toEqual({ targetChosen: false, workspace: "worktree" });
  expect(handoffSettings("t3_thread_launch", { scratch: true }, {})).toMatchObject({
    workspace: "scratch",
  });
  expect(
    handoffSettings(
      "create_threads",
      { threads: [{ prompt: "a" }, { prompt: "b", target: {} }] },
      {},
    ),
  ).toEqual({ batchSize: 2, targetChosen: true });
  expect(handoffSettings("t3_thread_send", { message: "secret" }, { delivery: "steered" })).toEqual(
    { delivery: "steered" },
  );
});

it("reads failure codes from declared tool errors even without isError", () => {
  expect(
    toolOutcome({
      structuredContent: {
        _tag: "OrchestratorMcpFailure",
        code: "capability_denied",
        message: "private detail",
      },
    }),
  ).toEqual({ outcome: "error", errorCode: "capability_denied" });
  expect(toolOutcome({ isError: false, structuredContent: { threadId: "t" } })).toEqual({
    outcome: "ok",
  });
  expect(toolOutcome(undefined)).toEqual({ outcome: "error", errorCode: "exception" });
});

it("tells user, agent, system, and scheduled work apart", () => {
  expect(callerOrigin({ thread: { createdBy: "user" }, scheduledRun: false })).toBe("user");
  expect(callerOrigin({ thread: { createdBy: "agent" }, scheduledRun: false })).toBe("agent");
  expect(callerOrigin({ thread: { createdBy: "system" }, scheduledRun: false })).toBe("system");
  expect(callerOrigin({ thread: { createdBy: "user" }, scheduledRun: true })).toBe("scheduler");
});
