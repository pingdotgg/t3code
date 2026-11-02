import { ProviderInstanceId, ThreadId, type ServerProvider } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import { type AgentThread, agentToolProperties, handoffSettings } from "./ProviderDimensions.ts";

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

it("drops input strings outside the schema's literals, since rejected calls are recorded too", () => {
  expect(handoffSettings("delegate_task", { mode: "/home/me/secret" }, undefined)).toEqual({
    targetChosen: false,
    mode: "async",
  });
  expect(
    handoffSettings("t3_thread_launch", { workspaceStrategy: { type: "/home/me/secret" } }, {}),
  ).toEqual({ targetChosen: false, workspace: "root" });
});
