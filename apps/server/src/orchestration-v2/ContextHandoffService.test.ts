import { assert, it } from "@effect/vitest";
import {
  ContextTransferId,
  MessageId,
  NodeId,
  OrchestrationV2ContextHandoffJson,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  historyCost,
  REPLACEMENT_HANDOFF_TOKEN_CAP,
} from "@t3tools/provider-core/server/handoffBudget";
import { deliverContextHandoffs } from "./ContextHandoffDelivery.ts";
import { ProjectionStoreThreadNotFoundError } from "./ProjectionStore.ts";

const layerTest = ContextHandoffService.layer.pipe(Layer.provide(IdAllocator.layer));
const encodeHandoff = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2ContextHandoffJson));
const decodeHandoff = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ContextHandoffJson),
);

function importedItem(
  input:
    | {
        readonly role: "user";
        readonly id: string;
        readonly text: string;
        readonly ordinal: number;
      }
    | {
        readonly role: "assistant";
        readonly id: string;
        readonly text: string;
        readonly ordinal: number;
      },
): Extract<OrchestrationV2TurnItem, { readonly type: "user_message" | "assistant_message" }> {
  const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
  const base = {
    id: TurnItemId.make(`turn-item:${input.id}`),
    threadId: ThreadId.make("thread:legacy-context"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.ordinal,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    messageId: MessageId.make(`message:${input.id}`),
    text: input.text,
  };
  return input.role === "user"
    ? {
        ...base,
        createdBy: "user",
        creationSource: "server",
        type: "user_message",
        inputIntent: "turn_start",
        attachments: [],
      }
    : {
        ...base,
        type: "assistant_message",
        streaming: false,
      };
}

it.layer(layerTest)("ContextHandoffService legacy import", (it) => {
  it.effect("prepares imported history for the first native v2 turn", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({
            role: "user",
            id: "one",
            text: "What did we decide? data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK38AAAAASUVORK5CYII=",
            ordinal: 1,
          }),
          importedItem({
            role: "assistant",
            id: "two",
            text: "We decided to keep the migration lightweight.",
            ordinal: 2,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.equal(handoff.strategy, "manual_context");
      assert.deepStrictEqual(handoff.fromProviderThreadIds, []);
      assert.include(handoff.summaryText, "What did we decide?");
      assert.notInclude(handoff.summaryText, "data:image/png");
      assert.include(handoff.summaryText, "keep the migration lightweight");
    }),
  );

  it.effect("preserves role attribution when truncating imported history", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({
            role: "user",
            id: "long",
            text: `${"x".repeat(35_000)} retained final words`,
            ordinal: 1,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.isAtMost(handoff.summaryText.length, 32_000);
      assert.include(handoff.summaryText, "User:\n... retained final words");
      assert.notMatch(handoff.summaryText, /\n+x+ retained final words/);
    }),
  );

  it.effect("retains the newest oversized import even when it has no whitespace", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({
            role: "assistant",
            id: "older",
            text: "older message",
            ordinal: 1,
          }),
          importedItem({
            role: "user",
            id: "long-single-token",
            text: `${"🧪".repeat(20_000)}LATEST_SINGLE_TOKEN`,
            ordinal: 2,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.include(
        handoff.history?.omittedItemIds ?? [],
        TurnItemId.make("turn-item:long-single-token"),
      );
      assert.isAtMost(handoff.summaryText.length, 32_000);
      assert.include(handoff.summaryText, "User:\n... ");
      assert.include(handoff.summaryText, "LATEST_SINGLE_TOKEN");
      assert.notInclude(handoff.summaryText, "\ufffd");
    }),
  );
});

it.layer(layerTest)("ContextHandoffService provider handoff", (it) => {
  it.effect.each([true, false])(
    "stores selected evidence once and delivers it intact after recovery (native=%s)",
    (native) =>
      Effect.gen(function* () {
        const service = yield* ContextHandoffService.ContextHandoffServiceV2;
        const user = importedItem({
          role: "user",
          id: "tool-history-user",
          text: "Check the failing tests and preserve the exact diagnostics.",
          ordinal: 1,
        });
        const commandOutput = `COMMAND_EVIDENCE_SENTINEL\n${"Assertion failed: expected 日本語 🧪\n".repeat(60)}`;
        const toolOutput = `TOOL_EVIDENCE_SENTINEL\n${"  preserve this diagnostic indentation\n".repeat(60)}`;
        const command: OrchestrationV2TurnItem = {
          ...user,
          id: TurnItemId.make("item:handoff-command"),
          type: "command_execution",
          ordinal: 2,
          status: "failed",
          input: "vp test",
          output: commandOutput,
          exitCode: 1,
        };
        const tool: OrchestrationV2TurnItem = {
          ...user,
          id: TurnItemId.make("item:handoff-tool"),
          type: "dynamic_tool",
          ordinal: 3,
          toolName: "diagnostics",
          input: { path: "src/example.ts" },
          output: { result: toolOutput },
        };
        const oversized: OrchestrationV2TurnItem = {
          ...command,
          id: TurnItemId.make("item:handoff-oversized"),
          ordinal: 4,
          output: `OMITTED_EVIDENCE_SENTINEL${"x".repeat(80_000)}`,
        };
        const target: OrchestrationV2ProviderThread = {
          id: ProviderThreadId.make("provider-thread:compact-receipt"),
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerSessionId: null,
          appThreadId: user.threadId,
          ownerNodeId: null,
          nativeThreadRef: {
            driver: ProviderDriverKind.make("codex"),
            strength: "strong",
            nativeId: "native:compact-receipt",
          },
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: user.updatedAt,
          updatedAt: user.updatedAt,
        };
        const handoff = yield* service.prepareProviderHandoff({
          threadId: user.threadId,
          targetRunId: RunId.make("run:compact-receipt"),
          transferId: null,
          fromProviderThreadIds: [],
          toProviderThreadId: target.id,
          fromProviderInstanceId: ProviderInstanceId.make("claudeAgent"),
          toProviderInstanceId: target.providerInstanceId,
          coveredRunOrdinals: { from: 1, to: 3 },
          strategy: native ? "delta_since_target_last_seen" : "full_thread_summary",
          items: [user, command, tool, oversized],
          createdAt: user.updatedAt,
        });
        const encoded = yield* encodeHandoff(handoff);
        assert.lengthOf(encoded.match(/COMMAND_EVIDENCE_SENTINEL/g) ?? [], 1);
        assert.lengthOf(encoded.match(/TOOL_EVIDENCE_SENTINEL/g) ?? [], 1);
        assert.notInclude(encoded, "OMITTED_EVIDENCE_SENTINEL");
        assert.include(handoff.summaryText, "t3_thread_read");
        assert.include(handoff.summaryText, user.threadId);
        assert.include(handoff.summaryText, "Selected 3 intact items; omitted 1 items.");
        assert.isBelow(Buffer.byteLength(handoff.summaryText), 2_000);
        assert.deepEqual(handoff.history?.omittedItemIds, [oversized.id]);
        const selected = handoff.history!.messages;
        assert.include(
          selected.find((message) => message.itemId === command.id)!.text,
          commandOutput,
        );
        assert.include(
          selected.find((message) => message.itemId === tool.id)!.text,
          JSON.stringify(toolOutput),
        );

        let durable = yield* decodeHandoff(encoded);
        const delivery = yield* deliverContextHandoffs({
          handoffs: [durable],
          providerThread: target,
          budget: 16_000,
          alreadyDeliveredItemIds: new Set(),
          inject: (history) => {
            assert.deepEqual(history.messages, selected);
            assert.isAtMost(historyCost(history.messages, history.context), 16_000);
            return Effect.succeed(native);
          },
          persist: (value) =>
            Effect.sync(() => {
              durable = value;
            }),
        });
        yield* delivery.delivered;
        if (native) assert.equal(delivery.context, "");
        else {
          assert.include(delivery.context, commandOutput);
          assert.include(delivery.context, JSON.stringify(toolOutput));
        }
        assert.deepEqual(
          durable.delivery?.itemIds,
          selected.map((message) => message.itemId),
        );
        assert.include(durable.delivery?.omittedItemIds ?? [], oversized.id);
        assert.equal(durable.delivery?.status, native ? "injected" : "inline");
        const delivered = yield* encodeHandoff(durable);
        assert.lengthOf(delivered.match(/COMMAND_EVIDENCE_SENTINEL/g) ?? [], 1);
        assert.lengthOf(delivered.match(/TOOL_EVIDENCE_SENTINEL/g) ?? [], 1);

        const bytes = "AQID".repeat(10_000);
        const oldText = `Keep the recovery decision. data:image/png;base64,${bytes} Continue the patch.`;
        const { history: oldHistory, ...withoutHistory } = handoff;
        for (const legacy of [false, true]) {
          const recovered = yield* decodeHandoff(
            yield* encodeHandoff(
              legacy
                ? { ...withoutHistory, summaryText: oldText }
                : {
                    ...handoff,
                    history: {
                      ...oldHistory!,
                      messages: [{ ...selected[0]!, text: oldText }],
                    },
                  },
            ),
          );
          const original = yield* encodeHandoff(recovered);
          const clean = yield* deliverContextHandoffs({
            handoffs: [recovered],
            providerThread: target,
            budget: 4_000,
            alreadyDeliveredItemIds: new Set(),
            inject: (value) => {
              const text = JSON.stringify(value);
              assert.include(text, "Keep the recovery decision.");
              assert.include(text, "Continue the patch.");
              assert.notInclude(text, bytes);
              return Effect.succeed(native);
            },
            persist: () => Effect.void,
          });
          if (!native) {
            assert.include(clean.context, "Keep the recovery decision.");
            assert.include(clean.context, "Continue the patch.");
            assert.notInclude(clean.context, bytes);
          }
          assert.equal(yield* encodeHandoff(recovered), original);
        }
      }),
  );

  it.effect(
    "keeps the six newest messages when a large subagent result fits the replacement budget",
    () =>
      Effect.gen(function* () {
        const service = yield* ContextHandoffService.ContextHandoffServiceV2;
        const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
        const threadId = ThreadId.make("thread:fresh-tail");
        const base = {
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          status: "completed" as const,
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        };
        const say = (
          id: string,
          role: "user" | "assistant",
          text: string,
          ordinal: number,
        ): OrchestrationV2TurnItem => importedItem({ role, id, text, ordinal });
        const crowded = ["FRESH_4", "FRESH_5", "FRESH_6"].map((marker, index) =>
          say(
            marker,
            index % 2 === 0 ? "user" : "assistant",
            `${marker}\n${"m".repeat(18_000)}`,
            index + 1,
          ),
        );
        const subagent = {
          ...base,
          id: TurnItemId.make("item:large-subagent"),
          ordinal: 4,
          type: "subagent" as const,
          subagentId: NodeId.make("node:large-subagent"),
          origin: "app_owned" as const,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          childThreadId: null,
          prompt: "Investigate the failure",
          result: `SUBAGENT_RESULT\n${"s".repeat(45_000)}`,
        } satisfies OrchestrationV2TurnItem;
        const recent = ["FRESH_1", "FRESH_2", "FRESH_3"].map((marker, index) =>
          say(marker, index % 2 === 0 ? "assistant" : "user", marker, index + 5),
        );
        const handoff = yield* service.prepareProviderHandoff({
          threadId,
          targetRunId: RunId.make("run:fresh-tail"),
          transferId: null,
          fromProviderThreadIds: [],
          toProviderThreadId: ProviderThreadId.make("provider-thread:fresh-tail"),
          fromProviderInstanceId: ProviderInstanceId.make("codex"),
          toProviderInstanceId: ProviderInstanceId.make("codex"),
          coveredRunOrdinals: { from: 1, to: 1 },
          strategy: "full_thread_summary",
          tokenCap: REPLACEMENT_HANDOFF_TOKEN_CAP,
          items: [say("opening", "user", "OPENING", 0), ...crowded, subagent, ...recent],
          createdAt: now,
        });
        const kept = handoff.history?.messages.map((message) => message.text).join("\n") ?? "";
        for (const marker of ["FRESH_1", "FRESH_2", "FRESH_3", "FRESH_4", "FRESH_5", "FRESH_6"]) {
          assert.include(kept, marker, "the six newest messages stay in the handoff");
        }
        assert.notInclude(kept, "SUBAGENT_RESULT");
        assert.include(handoff.history?.omittedItemIds ?? [], subagent.id);
        assert.isAtMost(
          historyCost(handoff.history?.messages ?? [], handoff.summaryText),
          REPLACEMENT_HANDOFF_TOKEN_CAP,
        );
      }),
  );
});

it.effect("caps the side chat context block without summarizing discarded parent history", () =>
  Effect.gen(function* () {
    const parentThreadId = ThreadId.make("thread:side-chat-parent");
    let summarizedItems = 0;
    const parentItems = Array.from({ length: 60 }, (_, index) => ({
      ...importedItem({
        role: index % 2 === 0 ? "user" : "assistant",
        id: `parent-${index}`,
        text: `item-${index} ${"x".repeat(228)}😀${"x".repeat(70)}`,
        ordinal: index,
      }),
      get text() {
        summarizedItems++;
        return `item-${index} ${"x".repeat(228)}😀${"x".repeat(70)}`;
      },
    }));
    const service = yield* ContextHandoffService.ContextHandoffServiceV2;
    const handoff = yield* service.prepareSideChatContext({
      parentThreadId,
      threadId: ThreadId.make("thread:side-chat"),
      targetRunId: RunId.make("run:side-chat"),
      transferId: ContextTransferId.make("transfer:side-chat"),
      toProviderThreadId: ProviderThreadId.make("provider-thread:side-chat"),
      fromProviderInstanceId: ProviderInstanceId.make("codex"),
      toProviderInstanceId: ProviderInstanceId.make("codex"),
      coveredRunOrdinals: { from: 1, to: 1 },
      parentItems,
      createdAt: DateTime.makeUnsafe(0),
    });
    const context = handoff.summaryText;
    assert.isBelow(summarizedItems, parentItems.length);

    assert.include(context, "- Earlier items truncated.");
    assert.notInclude(context, "item-0 ");
    assert.include(context, "- Assistant: item-59 ");
    assert.isAtMost(context.length, 8_000);
    assert.isTrue(context.isWellFormed());
    assert.isTrue(
      context.endsWith(
        `Use t3_thread_read on thread ${parentThreadId} to see the main thread's live state.`,
      ),
    );

    const bytes = "AQID".repeat(10_000);
    const sourceText = `Keep the side-chat decision. data:image/png;base64,${bytes} Continue the patch.`;
    const sourceItem = importedItem({
      role: "user",
      id: "binary-context",
      text: sourceText,
      ordinal: 1,
    });
    for (const digest of [[sourceItem], [`- User: ${sourceText}`]]) {
      const clean = ContextHandoffService.makeSideChatContext({ parentThreadId, digest });
      assert.include(clean, "Keep the side-chat decision.");
      assert.include(clean, "Continue the patch.");
      assert.notInclude(clean, "data:image/png");
      assert.notInclude(clean, bytes);
    }
    assert.equal(sourceItem.text, sourceText);

    const framingOnly = ContextHandoffService.makeSideChatContext({
      parentThreadId,
      digest: [],
    });
    const framing =
      "You are in a side chat beside the main thread. The main thread may still be running in the same worktree. Answer the user's questions; do not continue or redo the main thread's task.";
    const pointer = `Use t3_thread_read on thread ${parentThreadId} to see the main thread's live state.`;
    assert.equal(framingOnly, [framing, "", pointer].join("\n"));
    assert.equal(
      ContextHandoffService.makeSideChatContext({ parentThreadId, digest: ["- User: hello"] }),
      [
        framing,
        "",
        "Main thread activity since this side chat's starting point:",
        "- User: hello",
        "",
        pointer,
      ].join("\n"),
    );

    assert.equal(
      ContextHandoffService.makeSideChatContext({ parentThreadId, digest: [], seat: true }),
      "",
      "a seat takes part, so it gets no side chat framing or pointer at the main thread",
    );

    const withPeer = ContextHandoffService.makeSideChatContext({
      parentThreadId,
      digest: [
        {
          id: TurnItemId.make("turn-item:peer"),
          threadId: parentThreadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: null,
          completedAt: null,
          updatedAt: DateTime.makeUnsafe("2026-07-20T00:00:00.000Z"),
          type: "assistant_message",
          messageId: MessageId.make("message:peer"),
          text: "Use an event log",
          streaming: false,
          speaker: { label: "Astra", model: "gpt-6-astra" },
        },
      ],
    });
    assert.include(withPeer, "- Astra: Use an event log");

    const agentRow: OrchestrationV2TurnItem = {
      id: TurnItemId.make("turn-item:agent"),
      threadId: parentThreadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 2,
      status: "completed",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: DateTime.makeUnsafe("2026-07-20T00:00:00.000Z"),
      type: "user_message",
      messageId: MessageId.make("message:agent"),
      inputIntent: "turn_start",
      text: "From an agent",
      attachments: [],
      createdBy: "agent",
      creationSource: "mcp",
    };
    assert.include(
      ContextHandoffService.makeSideChatContext({
        parentThreadId,
        digest: [agentRow],
        seat: true,
      }),
      "- Agent: From an agent",
    );
    assert.include(
      ContextHandoffService.makeSideChatContext({ parentThreadId, digest: [agentRow] }),
      "- User: From an agent",
      "an ordinary side chat keeps its text",
    );

    const multiFilePatch = ContextHandoffService.makeSideChatContext({
      parentThreadId,
      digest: [
        {
          id: TurnItemId.make("turn-item:patch"),
          threadId: parentThreadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 60,
          status: "completed",
          title: null,
          startedAt: null,
          completedAt: null,
          updatedAt: DateTime.makeUnsafe(0),
          type: "file_change",
          fileName: "src/a.ts",
          changes: [
            { operation: "update", path: "src/a.ts" },
            { operation: "add", path: "src/b.ts" },
            { operation: "update", path: "src/new.ts", oldPath: "src/old.ts" },
          ],
        },
      ],
    });
    assert.include(multiFilePatch, "- File change: src/a.ts, src/b.ts, src/new.ts");
  }).pipe(Effect.provide(layerTest)),
);

it("covers the run range of a very long delta", () => {
  const runs = [
    { id: RunId.make("run:long-delta-early"), ordinal: 2 },
    { id: RunId.make("run:long-delta-late"), ordinal: 5 },
  ];
  const items = Array.from({ length: 150_000 }, (_, index) => ({
    runId: runs[index % 2]!.id,
  }));

  assert.deepEqual(
    ContextHandoffService.visibleDeltaRunOrdinals({ runs }, [...items, { runId: null }]),
    { from: 2, to: 5 },
  );
});

it.effect("inherited history stops at a missing fork ancestor", () =>
  Effect.gen(function* () {
    const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
    const threadId = ThreadId.make("thread:fork-of-missing");
    const thread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project:fork-of-missing"),
      title: "Fork of a missing thread",
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: {
        type: "run",
        threadId: ThreadId.make("thread:missing-ancestor"),
        runId: RunId.make("run:missing-ancestor"),
      },
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      deletedAt: null,
    };
    const items = yield* ContextHandoffService.readInheritedHandoffItems(
      {
        getThreadRecords: (missing) =>
          Effect.fail(new ProjectionStoreThreadNotFoundError({ threadId: missing })),
      },
      thread,
    );
    assert.deepEqual(items, []);
  }),
);
