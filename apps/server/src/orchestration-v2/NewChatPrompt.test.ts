import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as ServerSettings from "../serverSettings.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const projectId = ProjectId.make("project:new-chat-prompt");
const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Provider execution is disabled in prompt tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const cases: ReadonlyArray<{
  name: string;
  settings: Parameters<typeof ServerSettings.layerTest>[0];
  suffix: string;
  text?: string;
  createdBy?: "user" | "agent";
  fork?: boolean;
}> = [
  { name: "disabled by default", settings: { newChatPrompt: "Run relevant tests." }, suffix: "" },
  {
    name: "disabled",
    settings: { newChatPromptEnabled: false, newChatPrompt: "Run relevant tests." },
    suffix: "",
  },
  {
    name: "enabled",
    settings: { newChatPromptEnabled: true, newChatPrompt: "Run relevant tests." },
    suffix: "\n\nRun relevant tests.",
  },
  { name: "empty", settings: { newChatPromptEnabled: true, newChatPrompt: "   " }, suffix: "" },
  {
    name: "project override",
    settings: {
      newChatPromptEnabled: false,
      newChatPrompt: "Environment prompt",
      projectSettingsOverrides: {
        [projectId]: { newChatPromptEnabled: true, newChatPrompt: "Project instructions" },
      },
    },
    suffix: "\n\nProject instructions",
  },
  {
    name: "project disabled",
    settings: {
      newChatPromptEnabled: true,
      newChatPrompt: "Environment prompt",
      projectSettingsOverrides: { [projectId]: { newChatPromptEnabled: false } },
    },
    suffix: "",
  },
  {
    name: "native maintenance command",
    settings: { newChatPromptEnabled: true, newChatPrompt: "Run relevant tests." },
    text: "/compact",
    suffix: "",
  },
  {
    name: "agent message",
    settings: { newChatPromptEnabled: true, newChatPrompt: "Run relevant tests." },
    createdBy: "agent",
    suffix: "",
  },
  {
    name: "side chat fork",
    settings: { newChatPromptEnabled: true, newChatPrompt: "Run relevant tests." },
    fork: true,
    suffix: "",
  },
  {
    name: "resubmitted prompt",
    settings: { newChatPromptEnabled: true, newChatPrompt: "Run relevant tests." },
    text: "Implement search\n\nRun relevant tests.",
    suffix: "",
  },
];

it.effect.each(cases)("applies the new chat prompt once ($name)", (testCase) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    let threadId = ThreadId.make("thread:new-chat-prompt");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId,
      title: "New chat",
      modelSelection: { instanceId, model: "gpt-5" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    if (testCase.fork) {
      const targetThreadId = ThreadId.make("thread:fork");
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("fork"),
        sourceThreadId: threadId,
        targetThreadId,
        sourcePoint: { type: "latest_stable" },
        sideChat: true,
        createdBy: "user",
        creationSource: "web",
      });
      threadId = targetThreadId;
    }
    const first = {
      type: "message.dispatch",
      commandId: CommandId.make("first"),
      threadId,
      messageId: MessageId.make("message:first"),
      text: testCase.text ?? "Implement search",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: testCase.createdBy ?? "user",
      creationSource: "web",
    } as const;
    yield* orchestrator.dispatch(first);
    const replay = yield* orchestrator.dispatch(first);
    assert.isTrue(replay.replayed);
    yield* orchestrator.dispatch({
      ...first,
      commandId: CommandId.make("second"),
      messageId: MessageId.make("message:second"),
      text: "Also support filters",
    });
    const projection = yield* orchestrator.getThreadProjection(threadId);
    assert.deepEqual(
      projection.messages.map((message) => message.text),
      [`${first.text}${testCase.suffix}`, "Also support filters"],
    );
    const items = projection.turnItems.filter((item) => item.type === "user_message");
    assert.equal(items[0]?.text, `${first.text}${testCase.suffix}`);
  }).pipe(
    Effect.provide(
      ProviderReplayHarness.layerWithRegistry(
        { name: "new-chat-prompt" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { runEffectWorker: false, serverSettings: testCase.settings },
      ),
    ),
  ),
);
