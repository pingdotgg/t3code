import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { assert, describe, it } from "@effect/vitest";
import {
  ContextHandoffId,
  EventId,
  MessageId,
  NodeId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  OrchestrationV2ContextHandoff,
  type OrchestrationV2HistoricalMessage,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  contextUsageForHandoff,
  handoffBudget,
  latestNativeCompactionClearOrdinal,
  latestNativeContextUsage,
  mergeHandoffContextUsage,
  handoffCoverage,
  historyCost,
  historyResponseItems,
  selectHistory,
  historicalMessage,
} from "@t3tools/provider-core/server/handoffBudget";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { projectContextHandoffForWire } from "./WireProjection.ts";
import { deliverContextHandoffs } from "./ContextHandoffDelivery.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeHandoff = Schema.decodeUnknownSync(OrchestrationV2ContextHandoff);

const now = DateTime.makeUnsafe("2026-09-17T00:00:00Z");
const threadId = ThreadId.make("thread:handoff");
const providerThread: OrchestrationV2ProviderThread = {
  id: ProviderThreadId.make("provider-thread:target"),
  driver: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerSessionId: null,
  appThreadId: threadId,
  ownerNodeId: null,
  nativeThreadRef: {
    driver: ProviderDriverKind.make("codex"),
    strength: "strong",
    nativeId: "native:target",
  },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
};
const message = (
  id: string,
  role: "user" | "assistant",
  text: string,
): OrchestrationV2HistoricalMessage => ({
  itemId: TurnItemId.make(id),
  role,
  text,
  threadId,
  runId: RunId.make("run:source"),
  providerThreadId: ProviderThreadId.make("provider-thread:source"),
  status: "interrupted",
  kind: role === "user" ? "user_message" : "assistant_message",
});
const messages = [
  message("item:one", "user", "Preserve every line.\n\n  And this indentation.\n"),
  message("item:two", "assistant", "Partial work: 日本語 🧪 مرحبا\n" + "x".repeat(600)),
];
const handoff: OrchestrationV2ContextHandoff = {
  id: ContextHandoffId.make("handoff:one"),
  threadId,
  targetRunId: RunId.make("run:target"),
  fromProviderThreadIds: [],
  toProviderThreadId: providerThread.id,
  coveredRunOrdinals: { from: 1, to: 2 },
  strategy: "full_thread_summary",
  status: "ready",
  summaryMessageId: null,
  summaryText: "",
  history: {
    messages,
    coverage: "Historical context; retrieve thread:handoff with t3_thread_read.",
    omittedItems: 0,
  },
  createdByProviderInstanceId: null,
  createdAt: now,
  updatedAt: now,
};

describe("handoff budget", () => {
  it("keeps old preview handoffs readable and delivery history off the wire", () => {
    const projected = projectContextHandoffForWire({
      ...handoff,
      summaryText: "private transcript and command output",
      delivery: {
        nativeThreadId: "native:target",
        status: "injected",
        itemIds: [messages[0]!.itemId],
      },
    });
    assert.equal(projected.summaryText, "");
    assert.isUndefined(projected.history);
    assert.isUndefined(projected.delivery);
    assert.equal(decodeHandoff(projected).id, handoff.id);
    assert.deepEqual(handoff.history?.messages, messages);
  });
  it("carries command outcomes as attributed activity and excludes reasoning", () => {
    const base = {
      id: TurnItemId.make("item:command"),
      threadId,
      runId: RunId.make("run:source"),
      nodeId: null,
      providerThreadId: providerThread.id,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "failed" as const,
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    };
    const command = historicalMessage({
      ...base,
      type: "command_execution",
      input: "vp test",
      output: "Failure near the end: " + "界".repeat(300),
      exitCode: 1,
    });
    assert.equal(command?.role, "assistant");
    assert.equal(command?.kind, "command_execution");
    assert.include(command!.text, "Exit code: 1");
    assert.include(command!.text, "界".repeat(300));
    assert.equal(
      historicalMessage({
        ...base,
        type: "file_change",
        fileName: "src/a.ts",
        changes: [
          { operation: "update", path: "src/a.ts" },
          { operation: "add", path: "src/b.ts" },
          { operation: "update", path: "src/new.ts", oldPath: "src/old.ts" },
        ],
      })?.text,
      "File change: src/a.ts, src/b.ts, src/new.ts",
    );
    assert.equal(
      historicalMessage({ ...base, type: "file_change", fileName: "src/a.ts", changes: [] })?.text,
      "File change: src/a.ts",
    );
    assert.isNull(
      historicalMessage({
        ...base,
        type: "reasoning",
        text: "private reasoning",
        streaming: false,
      }),
    );
    assert.equal(historyResponseItems([command!], "Activity")[1]?.type, "message");
  });

  it("omits oversized multilingual items whole, preserves original constraints and recent work", () => {
    const candidates = [
      messages[0]!,
      message("huge", "assistant", "界🧪".repeat(20_000)),
      message("old", "assistant", "a".repeat(4_000)),
      messages[1]!,
    ];
    const selected = selectHistory({
      messages: candidates,
      coverage: "thread:handoff runs 1-4",
      budget: 3_000,
    });
    assert.deepEqual(selected.messages, messages);
    assert.equal(selected.omittedItems, 2);
    assert.isAtMost(historyCost(selected.messages, selected.context), 3_000);
  });

  it("points history recovery at the omitted items instead of a read from the thread's start", () => {
    const omitted = message("item:omitted", "assistant", "o".repeat(4_000));
    const selected = selectHistory({
      messages: [
        messages[0]!,
        omitted,
        ...Array.from({ length: 3 }, (_, i) => message(`item:recent-${i}`, "assistant", "recent")),
      ],
      coverage: handoffCoverage({ threadId, coveredRunOrdinals: { from: 1, to: 46 }, items: [] }),
      budget: 3_000,
    });
    assert.deepEqual(selected.omittedItemIds, [omitted.itemId]);
    assert.include(selected.context, omitted.itemId);
  });

  it("counts JSON escaping and UTF-8 bytes across many messages", () => {
    const candidates = Array.from({ length: 500 }, (_, i) =>
      message(`item:${i}`, i % 2 ? "assistant" : "user", '\u0000\\"🧪界'.repeat(15)),
    );
    for (const budget of [1_024, 4_000, 16_000]) {
      const selected = selectHistory({
        messages: candidates,
        coverage: "Retrieve omitted history",
        budget,
      });
      assert.isAtMost(historyCost(selected.messages, selected.context), budget);
      assert.isAbove(selected.omittedItems, 0);
    }
  });

  it("fits the final envelope at intermediate selected/omitted digit boundaries", () => {
    const candidates = Array.from({ length: 20 }, (_, index) =>
      message(`boundary:${index}`, "user", "Short request"),
    );
    for (let budget = 4_000; budget <= 9_000; budget++) {
      const selected = selectHistory({
        messages: candidates,
        coverage: "Recover history",
        omittedItems: 90,
        budget,
      });
      assert.isAtMost(historyCost(selected.messages, selected.context), budget);
    }
  });

  it("subtracts native usage, input, attachments, instructions and space for work", () => {
    const base = {
      tokenCap: 16_000,
      userText: "Continue",
      attachments: [],
      providerThread,
      nativeContextEstimate: 0,
      modelContextWindow: 32_000,
    };
    assert.isBelow(handoffBudget(base), 16_000);
    assert.isBelow(handoffBudget({ ...base, nativeContextEstimate: 8_000 }), handoffBudget(base));
    assert.equal(handoffBudget({ ...base, userText: "界".repeat(30_000) }), 0);
    assert.equal(
      handoffBudget({
        ...base,
        providerThread: {
          ...providerThread,
          contextUsage: { usedTokens: 23_000, maxTokens: 24_000 },
        },
      }),
      0,
    );
    for (const sizeBytes of [100_000, 10 * 1024 * 1024]) {
      const attachments = [
        {
          type: "image",
          id: "attachment",
          name: "image.png",
          mimeType: "image/png",
          sizeBytes,
        },
      ];
      const withImage = handoffBudget({ ...base, attachments });
      assert.isAbove(withImage, 4_000);
      assert.isBelow(withImage, handoffBudget(base));
      assert.equal(handoffBudget({ ...base, attachments: [...attachments, ...attachments] }), 0);
      assert.equal(
        handoffBudget({
          ...base,
          tokenCap: 64_000,
          modelContextWindow: 1_000_000,
          userText: "x".repeat(70_000),
          attachments,
          providerThread: {
            ...providerThread,
            contextUsage: { usedTokens: 0, maxTokens: 1_000_000 },
          },
        }),
        64_000,
      );
    }
    assert.equal(handoffBudget({ ...base, tokenCap: 2_000 }), 2_000);
    // The work reserve never takes more than half of a small local window.
    for (const [modelContextWindow, nativeContextEstimate, expected] of [
      [8_192, 0, 4_086],
      [32_768, 0, 16_758],
      [131_072, 50_000, 48_294],
    ] as const) {
      assert.equal(
        handoffBudget({ ...base, tokenCap: 64_000, modelContextWindow, nativeContextEstimate }),
        expected,
      );
    }
  });

  it("keeps measured occupancy across a model change", () => {
    const previous = {
      usedTokens: 37_321,
      maxTokens: 258_400,
      autoCompactThreshold: 32_000,
    };
    assert.isNull(
      contextUsageForHandoff({
        sameNativeThread: false,
        sameSelection: false,
        reuseTelemetry: false,
        previousUsage: previous,
      }),
    );
    assert.equal(
      contextUsageForHandoff({
        sameNativeThread: true,
        sameSelection: true,
        reuseTelemetry: true,
        previousUsage: previous,
      }),
      previous,
    );
    assert.deepEqual(
      contextUsageForHandoff({
        sameNativeThread: true,
        sameSelection: false,
        reuseTelemetry: true,
        previousUsage: previous,
      }),
      { usedTokens: 37_321, maxTokens: 258_400 },
    );
    assert.deepEqual(
      contextUsageForHandoff({
        sameNativeThread: true,
        sameSelection: false,
        reuseTelemetry: false,
        previousUsage: previous,
      }),
      { usedTokens: 37_321, maxTokens: 258_400 },
    );
    assert.deepEqual(
      contextUsageForHandoff({
        sameNativeThread: true,
        sameSelection: false,
        reuseTelemetry: false,
        previousUsage: {
          usedTokens: 30_000,
          maxTokens: 32_000,
          autoCompactThreshold: 31_000,
          updatedAt: "2026-11-23T12:00:00.000Z",
        },
        knownModelWindow: 1_000_000,
      }),
      { usedTokens: 30_000, maxTokens: 1_000_000, updatedAt: "2026-11-23T12:00:00.000Z" },
    );

    // A newer post-terminal thread usage correction supersedes older finalized turn usage
    // without mixing counts and timestamps from different measurements.
    assert.deepEqual(
      mergeHandoffContextUsage(
        { usedTokens: 80_000, maxTokens: 1_048_576, updatedAt: "2026-11-23T12:00:05.000Z" },
        {
          usage: { usedTokens: 245_000, maxTokens: 1_048_576 },
          reportedAt: "2026-11-23T12:00:00.000Z",
        },
      ),
      { usedTokens: 80_000, maxTokens: 1_048_576, updatedAt: "2026-11-23T12:00:05.000Z" },
    );
    // An older dated thread snapshot yields both its count and timestamp to a newer turn sample.
    assert.deepEqual(
      mergeHandoffContextUsage(
        { usedTokens: 190_000, maxTokens: 1_048_576, updatedAt: "2026-11-23T11:59:00.000Z" },
        {
          usage: { usedTokens: 245_000, maxTokens: 1_048_576 },
          reportedAt: "2026-11-23T12:00:00.000Z",
        },
      ),
      { usedTokens: 245_000, maxTokens: 1_048_576, updatedAt: "2026-11-23T12:00:00.000Z" },
    );
    // An undated thread snapshot (for example Claude) keeps the turn's count without adding updatedAt.
    assert.deepEqual(
      mergeHandoffContextUsage(
        { usedTokens: 190_000, maxTokens: 1_000_000 },
        {
          usage: { usedTokens: 210_000, maxTokens: 1_000_000 },
          reportedAt: "2026-11-23T12:00:00.000Z",
        },
      ),
      { usedTokens: 210_000, maxTokens: 1_000_000 },
    );
    // Antigravity preserves the measured turn's reportedAt when no dated thread snapshot exists.
    assert.deepEqual(
      mergeHandoffContextUsage(
        null,
        {
          usage: { usedTokens: 245_000, maxTokens: 1_048_576 },
          reportedAt: "2026-11-23T12:00:00.000Z",
        },
        true,
      ),
      { usedTokens: 245_000, maxTokens: 1_048_576, updatedAt: "2026-11-23T12:00:00.000Z" },
    );

    const preserved = contextUsageForHandoff({
      sameNativeThread: true,
      sameSelection: false,
      reuseTelemetry: false,
      previousUsage: previous,
    });
    assert.equal(
      handoffBudget({
        tokenCap: 16_000,
        userText: "Continue work",
        attachments: [
          {
            type: "image",
            id: "screenshot-a",
            name: "a.png",
            mimeType: "image/png",
            sizeBytes: 100_000,
          },
          {
            type: "image",
            id: "screenshot-b",
            name: "b.png",
            mimeType: "image/png",
            sizeBytes: 100_000,
          },
        ],
        providerThread: { ...providerThread, contextUsage: preserved },
        nativeContextEstimate: 0,
        modelContextWindow: preserved?.maxTokens,
      }),
      16_000,
    );
    assert.equal(
      handoffBudget({
        tokenCap: 16_000,
        userText: "Continue work",
        attachments: [],
        providerThread,
        nativeContextEstimate: 120_000,
      }),
      0,
    );
  });
  it("reserves context for image batches up to the attachment limit, honoring smaller known windows", () => {
    let previousBudget = 16_000;
    for (let count = 1; count <= PROVIDER_SEND_TURN_MAX_ATTACHMENTS; count++) {
      const input = {
        tokenCap: 16_000,
        userText: "Compare these screenshots",
        providerThread,
        nativeContextEstimate: 0,
        attachments: Array.from({ length: count }, (_, index) => ({
          type: "image",
          id: `image-${index}`,
          name: "image.png",
          mimeType: "image/png",
          sizeBytes: 100_000,
        })),
      };
      const budget = handoffBudget(input);
      assert.isAtLeast(budget, 0);
      assert.isAtMost(budget, previousBudget);
      previousBudget = budget;
      if (count <= 8) assert.equal(budget, 16_000);
      if (count === 10) {
        assert.isAbove(budget, 0);
        assert.isBelow(budget, 16_000);
      }
      if (count === PROVIDER_SEND_TURN_MAX_ATTACHMENTS) assert.equal(budget, 0);
      if (budget > 0) {
        const selected = selectHistory({ messages, coverage: "Recover omitted history", budget });
        assert.isAtMost(historyCost(selected.messages, selected.context), budget);
      }
      assert.equal(handoffBudget({ ...input, modelContextWindow: 2_000_000 }), 16_000);
      // 20k window: half is reserved for work, then 27 prompt bytes and 8,192 per image.
      const smallWindowBudget = count === 1 ? 1_781 : 0;
      assert.equal(handoffBudget({ ...input, modelContextWindow: 20_000 }), smallWindowBudget);
      assert.equal(
        handoffBudget({
          ...input,
          providerThread: { ...providerThread, contextUsage: { usedTokens: 0, maxTokens: 20_000 } },
        }),
        smallWindowBudget,
      );
      assert.equal(
        handoffBudget({
          ...input,
          modelContextWindow: 1_000_000,
          providerThread: {
            ...providerThread,
            contextUsage: { usedTokens: 0, maxTokens: 1_000_000, autoCompactThreshold: 20_000 },
          },
        }),
        smallWindowBudget,
      );
    }
  });
});

describe("handoff delivery", () => {
  it.effect.each([
    { native: true, label: "injected" },
    { native: false, label: "inline" },
  ])("records omitted recovery coverage separately from $label text", ({ native }) =>
    Effect.gen(function* () {
      const omittedBeforeDelivery = TurnItemId.make("item:omitted-during-preparation");
      const oversized = message("item:oversized", "user", "x".repeat(20_000));
      let durable: OrchestrationV2ContextHandoff = {
        ...handoff,
        history: {
          ...handoff.history!,
          messages: [...messages, oversized],
          omittedItems: 1,
          omittedItemIds: [omittedBeforeDelivery],
        },
      };
      const result = yield* deliverContextHandoffs({
        handoffs: [durable],
        providerThread,
        budget: 16_000,
        alreadyDeliveredItemIds: new Set(),
        inject: (value) => {
          assert.include(value.context, "omitted 2 items");
          assert.notInclude(
            value.messages.map((item) => item.itemId),
            oversized.itemId,
          );
          return Effect.succeed(native);
        },
        persist: (value) =>
          Effect.sync(() => {
            durable = value;
          }),
      });
      assert.equal(durable.delivery?.status, native ? "injected" : "pending");
      yield* result.delivered;
      assert.equal(durable.delivery?.status, native ? "injected" : "inline");
      assert.deepEqual(
        durable.delivery?.itemIds,
        messages.map((item) => item.itemId),
      );
      assert.deepEqual(durable.delivery?.omittedItemIds, [omittedBeforeDelivery, oversized.itemId]);
      assert.deepEqual(decodeHandoff(durable).delivery, durable.delivery);
    }),
  );

  it.effect("persists successful injection before turn start and skips it on retry", () =>
    Effect.gen(function* () {
      let durable = handoff;
      const history: unknown[] = [];
      const statuses: string[] = [];
      const input = {
        providerThread,
        budget: 16_000,
        alreadyDeliveredItemIds: new Set<string>(),
        inject: (value: ProviderAdapter.ProviderAdapterV2HistoricalContext) =>
          Effect.sync(() => {
            history.push(...historyResponseItems(value.messages, value.context));
            return true;
          }),
        persist: (value: OrchestrationV2ContextHandoff) =>
          Effect.sync(() => {
            durable = value;
            statuses.push(value.delivery!.status);
          }),
      };
      const first = yield* deliverContextHandoffs({ ...input, handoffs: [durable] });
      assert.equal(first.context, "");
      assert.deepEqual(statuses, ["pending", "injected"]);
      assert.lengthOf(history, 3);
      const second = yield* deliverContextHandoffs({ ...input, handoffs: [durable] });
      assert.equal(second.context, "");
      assert.lengthOf(history, 3);
    }),
  );

  it.effect(
    "uses the same selection on explicit native fallback, marking only accepted input",
    () =>
      Effect.gen(function* () {
        let durable = handoff;
        const result = yield* deliverContextHandoffs({
          handoffs: [handoff],
          providerThread,
          budget: 16_000,
          alreadyDeliveredItemIds: new Set(),
          inject: () => Effect.succeed(false),
          persist: (value) =>
            Effect.sync(() => {
              durable = value;
            }),
        });
        assert.include(result.context, messages[0]!.text);
        assert.include(result.context, messages[1]!.text);
        assert.equal(durable.delivery?.status, "pending");
        yield* result.delivered;
        assert.equal(durable.delivery?.status, "inline");
      }),
  );

  it.effect(
    "defers unsupported compaction history until a normal turn without marking delivery uncertain",
    () =>
      Effect.gen(function* () {
        let durable = handoff;
        const persist = (value: OrchestrationV2ContextHandoff) =>
          Effect.sync(() => {
            durable = value;
          });
        const compact = yield* deliverContextHandoffs({
          handoffs: [durable],
          providerThread,
          budget: 16_000,
          alreadyDeliveredItemIds: new Set(),
          deferInline: true,
          inject: () => Effect.succeed(false),
          persist,
        });
        yield* compact.delivered;
        assert.equal(compact.context, "");
        assert.isUndefined((() => durable.delivery)());
        const next = yield* deliverContextHandoffs({
          handoffs: [durable],
          providerThread,
          budget: 16_000,
          alreadyDeliveredItemIds: new Set(),
          inject: () => Effect.succeed(false),
          persist,
        });
        assert.include(next.context, messages[0]!.text);
        yield* next.delivered;
        assert.equal(durable.delivery?.status, "inline");
      }),
  );

  it.effect("bounds accumulated recovery markers while keeping omitted history discoverable", () =>
    Effect.gen(function* () {
      const many = Array.from({ length: 100 }, (_, index) => ({
        ...handoff,
        id: ContextHandoffId.make(`handoff:retry:${index}`),
      }));
      let captured: ProviderAdapter.ProviderAdapterV2HistoricalContext | undefined;
      const result = yield* deliverContextHandoffs({
        handoffs: many,
        providerThread,
        budget: 2_500,
        alreadyDeliveredItemIds: new Set(),
        inject: (history) =>
          Effect.sync(() => {
            captured = history;
            return true;
          }),
        persist: () => Effect.void,
      });
      assert.equal(result.context, "");
      assert.isDefined(captured);
      assert.include(captured.context, "detailed coverage references omitted");
      assert.include(captured.context, "t3_thread_read");
      assert.include(captured.context, threadId);
      assert.isAtMost(historyCost(captured.messages, captured.context), 2_500);
      assert.isAbove(captured.messages.length, 0);
    }),
  );

  it.effect("does not redeliver after ambiguous injection failure", () =>
    Effect.gen(function* () {
      let durable = handoff;
      let calls = 0;
      const input = {
        providerThread,
        budget: 16_000,
        alreadyDeliveredItemIds: new Set<string>(),
        inject: () =>
          Effect.sync(() => {
            calls++;
          }).pipe(Effect.andThen(Effect.fail("connection lost"))),
        persist: (value: OrchestrationV2ContextHandoff) =>
          Effect.sync(() => {
            durable = value;
          }),
      };
      yield* deliverContextHandoffs({ ...input, handoffs: [durable] }).pipe(Effect.result);
      assert.equal(durable.delivery?.status, "pending");
      const retry = yield* deliverContextHandoffs({ ...input, handoffs: [durable] }).pipe(
        Effect.result,
      );
      assert.equal(retry._tag, "Failure");
      assert.equal(calls, 1);
    }),
  );

  it.effect("budgets multiple handoffs together and skips previously delivered items", () =>
    Effect.gen(function* () {
      const extra = {
        ...handoff,
        id: ContextHandoffId.make("handoff:two"),
        history: {
          ...handoff.history!,
          messages: [...messages, message("item:three", "assistant", "Latest result")],
        },
      };
      let delivered: ReadonlyArray<unknown> = [];
      yield* deliverContextHandoffs({
        handoffs: [handoff, extra],
        providerThread,
        budget: 2_500,
        alreadyDeliveredItemIds: new Set(["item:one"]),
        inject: (value) =>
          Effect.sync(() => {
            delivered = historyResponseItems(value.messages, value.context);
            return true;
          }),
        persist: () => Effect.void,
      });
      const serialized = yield* encodeJson(delivered);
      assert.isAtMost(Buffer.byteLength(serialized), 2_500);
      assert.notInclude(serialized, "Preserve every line");
      assert.equal(serialized.split("Partial work").length - 1, 1);
      assert.include(serialized, "Latest result");
    }),
  );

  it.effect("fails before delivery when even the coverage marker cannot fit", () =>
    Effect.gen(function* () {
      let calls = 0;
      const result = yield* deliverContextHandoffs({
        handoffs: [handoff],
        providerThread,
        budget: 0,
        alreadyDeliveredItemIds: new Set(),
        inject: () =>
          Effect.sync(() => {
            calls++;
            return true;
          }),
        persist: () => Effect.void,
      }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.equal(calls, 0);
    }),
  );

  it.effect(
    "does not revive pre-compaction usage through ProjectionStore.getTurnStartContext on the next turn",
    () =>
      Effect.gen(function* () {
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const compactThreadId = ThreadId.make("thread:post-compact-handoff");
        const agInstanceId = ProviderInstanceId.make("antigravity");
        const agDriver = ProviderDriverKind.make("antigravity");
        const agModel = { instanceId: agInstanceId, model: "gemini-4-neon" };
        const agProviderThreadId = ProviderThreadId.make("provider-thread:ag-compact");
        const agNativeId = "ag-native-compact-1";
        const t1 = DateTime.makeUnsafe("2026-11-23T12:00:00.000Z");
        const t2 = DateTime.makeUnsafe("2026-11-23T12:05:00.000Z");
        const t3 = DateTime.makeUnsafe("2026-11-23T12:10:00.000Z");
        const t4 = DateTime.makeUnsafe("2026-11-23T12:15:00.000Z");
        const agProviderThread: OrchestrationV2ProviderThread = {
          id: agProviderThreadId,
          driver: agDriver,
          providerInstanceId: agInstanceId,
          providerSessionId: null,
          appThreadId: compactThreadId,
          ownerNodeId: null,
          nativeThreadRef: { driver: agDriver, nativeId: agNativeId, strength: "strong" },
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: 1,
          lastRunOrdinal: 2,
          handoffIds: [],
          forkedFrom: null,
          contextUsage: null,
          createdAt: t1,
          updatedAt: t2,
        };
        const run1Id = RunId.make("run:ag:1");
        const run2Id = RunId.make("run:ag:2");
        const run3Id = RunId.make("run:ag:3");
        const run4Id = RunId.make("run:ag:4");
        const node1Id = NodeId.make("node:ag:1");
        const node2Id = NodeId.make("node:ag:2");
        const node3Id = NodeId.make("node:ag:3");
        const node4Id = NodeId.make("node:ag:4");
        const attempt1Id = RunAttemptId.make("attempt:ag:1");
        const attempt2Id = RunAttemptId.make("attempt:ag:2");
        const attempt3Id = RunAttemptId.make("attempt:ag:3");
        let eventOrdinal = 0;
        const nextEventId = () => EventId.make(`event:ag-compact:${++eventOrdinal}`);
        const putRun = (
          runId: RunId,
          ordinal: number,
          nodeId: NodeId,
          status: "completed" | "queued",
          at: DateTime.Utc,
        ) =>
          projectionStore.apply({
            id: nextEventId(),
            type: "run.updated",
            threadId: compactThreadId,
            runId,
            occurredAt: at,
            payload: {
              id: runId,
              threadId: compactThreadId,
              ordinal,
              providerInstanceId: agInstanceId,
              modelSelection: agModel,
              providerThreadId: agProviderThreadId,
              userMessageId: MessageId.make(`msg:ag:${ordinal}`),
              rootNodeId: nodeId,
              activeAttemptId: null,
              status,
              requestedAt: at,
              startedAt: status === "completed" ? at : null,
              completedAt: status === "completed" ? at : null,
              checkpointId: null,
              contextHandoffId: null,
            },
          });
        const putAttempt = (
          attemptId: RunAttemptId,
          runId: RunId,
          nodeId: NodeId,
          providerTurnId: ProviderTurnId,
          at: DateTime.Utc,
        ) =>
          projectionStore.apply({
            id: nextEventId(),
            type: "run-attempt.updated",
            threadId: compactThreadId,
            runId,
            occurredAt: at,
            payload: {
              id: attemptId,
              runId,
              providerInstanceId: agInstanceId,
              providerThreadId: agProviderThreadId,
              providerTurnId,
              rootNodeId: nodeId,
              nativeThreadId: agNativeId,
              attemptOrdinal: 1,
              reason: "initial",
              status: "completed",
              startedAt: at,
              completedAt: at,
            },
          });

        yield* projectionStore.apply({
          id: nextEventId(),
          type: "thread.created",
          threadId: compactThreadId,
          occurredAt: t1,
          payload: {
            id: compactThreadId,
            projectId: ProjectId.make("project:ag-compact"),
            title: "Post-compact handoff",
            createdBy: "user",
            creationSource: "web",
            providerInstanceId: agInstanceId,
            modelSelection: agModel,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: agProviderThreadId,
            lineage: {
              rootThreadId: compactThreadId,
              parentThreadId: null,
              relationshipToParent: null,
            },
            forkedFrom: null,
            createdAt: t1,
            updatedAt: t2,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: t2,
            deletedAt: null,
          },
        });
        yield* projectionStore.apply({
          id: nextEventId(),
          type: "provider-thread.updated",
          threadId: compactThreadId,
          runId: run2Id,
          occurredAt: t2,
          payload: agProviderThread,
        });
        yield* putRun(run1Id, 1, node1Id, "completed", t1);
        yield* putAttempt(attempt1Id, run1Id, node1Id, ProviderTurnId.make("turn:ag:1"), t1);
        yield* projectionStore.apply({
          id: nextEventId(),
          type: "provider-turn.updated",
          threadId: compactThreadId,
          runId: run1Id,
          occurredAt: t1,
          payload: {
            id: ProviderTurnId.make("turn:ag:1"),
            providerThreadId: agProviderThreadId,
            nodeId: node1Id,
            runAttemptId: attempt1Id,
            nativeTurnRef: null,
            ordinal: 1,
            status: "completed",
            startedAt: t1,
            completedAt: t1,
            tokenUsage: {
              usedTokens: 245_000,
              maxTokens: 256_000,
              updatedAt: DateTime.formatIso(t1),
            },
          },
        });
        // Run 2: completed /compact emits compaction item + synthetic compaction-clear tokenUsage.
        yield* putRun(run2Id, 2, node2Id, "completed", t2);
        yield* putAttempt(attempt2Id, run2Id, node2Id, ProviderTurnId.make("turn:ag:2"), t2);
        yield* projectionStore.apply({
          id: nextEventId(),
          type: "provider-turn.updated",
          threadId: compactThreadId,
          runId: run2Id,
          occurredAt: t2,
          payload: {
            id: ProviderTurnId.make("turn:ag:2"),
            providerThreadId: agProviderThreadId,
            nodeId: node2Id,
            runAttemptId: attempt2Id,
            nativeTurnRef: null,
            ordinal: 2,
            status: "completed",
            startedAt: t2,
            completedAt: t2,
            tokenUsage: {
              usedTokens: 0,
              updatedAt: DateTime.formatIso(t2),
            },
          },
        });
        yield* projectionStore.apply({
          id: nextEventId(),
          type: "turn-item.updated",
          threadId: compactThreadId,
          runId: run2Id,
          occurredAt: t2,
          payload: {
            id: TurnItemId.make("item:ag:compact"),
            threadId: compactThreadId,
            runId: run2Id,
            nodeId: node2Id,
            providerThreadId: agProviderThreadId,
            providerTurnId: ProviderTurnId.make("turn:ag:2"),
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            type: "compaction",
            driver: agDriver,
            status: "completed",
            title: "Context compacted",
            startedAt: t2,
            completedAt: t2,
            updatedAt: t2,
          },
        });
        // Run 3: next user turn after /compact.
        yield* putRun(run3Id, 3, node3Id, "queued", t3);
        const turn3Start = yield* projectionStore.getTurnStartContext(compactThreadId, run3Id);
        // Production getTurnStartContext scopes turnItems to run3Id, excluding run2's compaction item.
        assert.deepEqual(turn3Start.turnItems, []);
        const measuredAfterCompact = latestNativeContextUsage(turn3Start, agProviderThread);
        assert.isUndefined(measuredAfterCompact);
        assert.strictEqual(latestNativeCompactionClearOrdinal(turn3Start, agProviderThread), 2);
        const nextTurnUsage = contextUsageForHandoff({
          sameNativeThread: true,
          sameSelection: true,
          reuseTelemetry: true,
          previousUsage: mergeHandoffContextUsage(
            agProviderThread.contextUsage,
            measuredAfterCompact,
            true,
          ),
        });
        assert.isNull(nextTurnUsage);
        assert.isAbove(
          handoffBudget({
            tokenCap: 16_000,
            userText: "Continue",
            attachments: [],
            providerThread: { ...agProviderThread, contextUsage: nextTurnUsage },
            nativeContextEstimate: 0,
            modelContextWindow: 256_000,
          }),
          0,
        );

        // Once Run 3 reports fresh post-compaction usage, Run 4 picks it up cleanly.
        yield* putRun(run3Id, 3, node3Id, "completed", t3);
        yield* putAttempt(attempt3Id, run3Id, node3Id, ProviderTurnId.make("turn:ag:3"), t3);
        yield* projectionStore.apply({
          id: nextEventId(),
          type: "provider-turn.updated",
          threadId: compactThreadId,
          runId: run3Id,
          occurredAt: t3,
          payload: {
            id: ProviderTurnId.make("turn:ag:3"),
            providerThreadId: agProviderThreadId,
            nodeId: node3Id,
            runAttemptId: attempt3Id,
            nativeTurnRef: null,
            ordinal: 3,
            status: "completed",
            startedAt: t3,
            completedAt: t3,
            tokenUsage: {
              usedTokens: 60_000,
              maxTokens: 256_000,
              updatedAt: DateTime.formatIso(t3),
            },
          },
        });
        yield* putRun(run4Id, 4, node4Id, "queued", t4);
        const turn4Start = yield* projectionStore.getTurnStartContext(compactThreadId, run4Id);
        assert.isUndefined(latestNativeCompactionClearOrdinal(turn4Start, agProviderThread));
        assert.deepEqual(latestNativeContextUsage(turn4Start, agProviderThread)?.usage, {
          usedTokens: 60_000,
          maxTokens: 256_000,
        });
      }).pipe(
        Effect.provide(ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
      ),
  );
});
