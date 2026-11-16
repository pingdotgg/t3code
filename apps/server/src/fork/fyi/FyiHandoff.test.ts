import { assert, it } from "@effect/vitest";
import {
  MessageId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { historicalMessage } from "@t3tools/provider-core/server/handoffBudget";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ContextHandoffService from "../../orchestration-v2/ContextHandoffService.ts";

it("frames an FYI a turn carried and leaves out a runless one", () => {
  const now = DateTime.makeUnsafe("2026-09-17T00:00:00Z");
  const fyi = {
    id: TurnItemId.make("item:fyi"),
    threadId: ThreadId.make("thread:handoff"),
    runId: RunId.make("run:source"),
    nodeId: null,
    providerThreadId: ProviderThreadId.make("provider-thread:target"),
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "user_message" as const,
    messageId: MessageId.make("message:fyi"),
    createdBy: "agent" as const,
    creationSource: "mcp" as const,
    senderThreadId: ThreadId.make("thread:chief"),
    inputIntent: "steer" as const,
    text: "main moved",
    attachments: [],
    fyi: true as const,
  };
  assert.equal(
    historicalMessage(fyi)?.text,
    '<fyi from="thread thread:chief" sent="2026-09-17T00:00:00.000Z">\nmain moved\n</fyi>',
  );
  assert.isNull(historicalMessage({ ...fyi, runId: null, status: "pending" }));
});

it.effect("hands off the FYI messages a turn carried, framed as FYIs, and no runless one", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:fyi-history");
    const sent = DateTime.makeUnsafe("2026-11-16T05:42:00.000Z");
    const run = (key: string, status: OrchestrationV2Run["status"], ordinal: number) => ({
      id: RunId.make(`run:${key}`),
      threadId,
      ordinal,
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${key}`),
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: sent,
      startedAt: sent,
      completedAt: sent,
      checkpointId: null,
      contextHandoffId: null,
    });
    const fyi = (
      key: string,
      runId: RunId | null,
      status: "pending" | "completed",
    ): OrchestrationV2TurnItem => ({
      id: TurnItemId.make(`item:${key}`),
      threadId,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status,
      title: null,
      startedAt: sent,
      completedAt: null,
      updatedAt: sent,
      type: "user_message",
      messageId: MessageId.make(`message:${key}`),
      createdBy: "agent",
      creationSource: "mcp",
      senderThreadId: ThreadId.make("thread:chief"),
      inputIntent: "steer",
      text: key,
      attachments: [],
      fyi: true,
    });
    const failed = run("failed", "failed", 1);
    const kept = run("kept", "completed", 2);
    const items = [
      fyi("waiting", null, "pending"),
      fyi("given-back", failed.id, "completed"),
      fyi("read", kept.id, "completed"),
    ];
    const element = '<fyi from="thread thread:chief" sent="2026-11-16T05:42:00.000Z">';

    const service = yield* ContextHandoffService.ContextHandoffServiceV2;
    const handoff = yield* service.prepareProviderHandoff({
      threadId,
      targetRunId: RunId.make("run:next"),
      transferId: null,
      fromProviderThreadIds: [],
      toProviderThreadId: ProviderThreadId.make("provider-thread:fyi-history"),
      fromProviderInstanceId: ProviderInstanceId.make("codex"),
      toProviderInstanceId: ProviderInstanceId.make("codex"),
      coveredRunOrdinals: { from: 1, to: 2 },
      runs: [failed, kept],
      strategy: "full_thread_summary",
      items,
      createdAt: sent,
    });
    assert.deepEqual(
      handoff.history?.messages.map(({ text }) => text),
      [`${element}\ngiven-back\n</fyi>`, `${element}\nread\n</fyi>`],
    );

    const sideChat = ContextHandoffService.makeSideChatContext({
      parentThreadId: threadId,
      digest: [items[0]!, items[2]!],
    });
    assert.include(sideChat, `- ${element} read </fyi>`);
    assert.notInclude(sideChat, "waiting");
  }).pipe(Effect.provide(ContextHandoffService.layer.pipe(Layer.provide(IdAllocator.layer)))),
);
