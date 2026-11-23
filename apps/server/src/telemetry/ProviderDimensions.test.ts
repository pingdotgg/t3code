import { ProviderInstanceId, ThreadId, type ServerProvider } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import { type AgentThread, agentToolProperties, handoffSettings } from "./ProviderDimensions.ts";

const provider = (
  instanceId: string,
  driver: string,
  models: ReadonlyArray<{ slug: string; isCustom: boolean }>,
  auth: Record<string, string> = {},
) =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver,
    auth: { status: "authenticated", ...auth },
    models,
  }) as unknown as ServerProvider;

const providers = [
  provider("work-codex", "codex", [{ slug: "gpt-5.5", isCustom: false }]),
  provider("azure-codex", "codex", [{ slug: "gpt-acme-finetune", isCustom: false }], {
    endpoint: "https://acme.example.com",
  }),
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

it("omits custom, user-configured, endpoint-served, and unknown models and instance names", () => {
  expect(
    agentToolProperties({
      tool: "t3_thread_send",
      providers,
      caller: thread("claudeAgent", "my-private-finetune"),
      targets: [
        thread("opencode", "ollama/acme-internal"),
        thread("removed-instance", "gpt-5.5"),
        thread("azure-codex", "gpt-acme-finetune"),
      ],
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
    {
      callerProvider: "claudeAgent",
      callerModel: undefined,
      targetProvider: "codex",
      targetModel: undefined,
    },
  ]);
});

it("drops input strings outside the schema's literals, since rejected calls are recorded too", () => {
  expect(handoffSettings("delegate_task", { mode: "/home/me/secret" }, undefined)).toEqual({
    targetChosen: false,
    mode: "async",
  });
  expect(
    handoffSettings("t3_thread_launch", { workspaceStrategy: { type: "/home/me/secret" } }, {}),
  ).toEqual({ targetChosen: false, workspace: "root" });
});

it("records the binding the saved scheduled task resolved to, and none for failures", () => {
  expect(handoffSettings("schedule_task", {}, { boundThreadId: null })).toEqual({
    bindToCurrentThread: false,
  });
  expect(
    handoffSettings(
      "schedule_task",
      { bindToCurrentThread: true },
      { _tag: "OrchestratorMcpFailure", code: "invalid_request", message: "Different project." },
    ),
  ).toEqual({});
});
