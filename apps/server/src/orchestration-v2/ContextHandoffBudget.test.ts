import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  ContextHandoffId,
  NodeId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ProjectFactId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  OrchestrationV2ContextHandoff,
  type OrchestrationV2HistoricalMessage,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  contextUsageForHandoff,
  estimateTextTokens,
  handoffBudget,
  handoffCoverage,
  historyCost,
  historyResponseItems,
  latestNativeContextUsage,
  nativeContextHistory,
  selectHistory,
  historicalMessage,
} from "@t3tools/provider-core/server/handoffBudget";
import { projectContextHandoffForWire } from "./WireProjection.ts";
import { deliverContextHandoffs } from "./ContextHandoffDelivery.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeHandoff = Schema.decodeUnknownSync(OrchestrationV2ContextHandoff);

const now = DateTime.makeUnsafe("2026-09-17T00:00:00Z");
const threadId = ThreadId.make("thread:handoff");
const summaryScope = { projectId: ProjectId.make("project:handoff"), threadId };
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
  it("measures a native conversation by the turns still in it", () => {
    const report = (ordinal: number, usedTokens: number, nativeThreadId: string) => ({
      run: {
        id: `run:${ordinal}`,
        status: ordinal === 3 ? "rolled_back" : "completed",
        modelSelection: { instanceId: "codex", model: "gpt" },
      },
      attempt: {
        id: `attempt:${ordinal}`,
        runId: `run:${ordinal}`,
        providerThreadId: providerThread.id,
        nativeThreadId,
        rootNodeId: `node:${ordinal}`,
      },
      turn: {
        providerThreadId: providerThread.id,
        runAttemptId: `attempt:${ordinal}`,
        nodeId: `node:${ordinal}`,
        tokenUsage: { usedTokens, updatedAt: `2026-09-17T00:0${ordinal}:00Z` },
      },
    });
    const reports = [
      report(1, 20_000, "native:target"),
      report(2, 80_000, "native:target"),
      // Rolled back: the conversation no longer holds this turn.
      report(3, 190_000, "native:target"),
      report(4, 300_000, "native:replaced"),
    ];
    const projection = {
      runs: reports.map(({ run }) => run),
      attempts: reports.map(({ attempt }) => attempt),
      providerTurns: reports.map(({ turn }) => turn),
    } as unknown as Parameters<typeof latestNativeContextUsage>[0];
    const measured = latestNativeContextUsage(projection, providerThread);
    assert.deepEqual(
      { used: measured?.usage.usedTokens, first: measured?.firstUsedTokens },
      { used: 80_000, first: 20_000 },
    );
    // A fresh conversation with no report yet is unmeasured, so it cannot restart again.
    assert.isUndefined(
      latestNativeContextUsage(projection, {
        ...providerThread,
        nativeThreadRef: { ...providerThread.nativeThreadRef!, nativeId: "native:fresh" },
      }),
    );
  });

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
  it("carries complete tool evidence as attributed activity and excludes reasoning", () => {
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
    const imageOutput = JSON.stringify({ type: "image", data: "AAECAw==", mimeType: "image/png" });
    const imageCommand = historicalMessage({
      ...base,
      type: "command_execution",
      input: "read screenshot.png",
      output: imageOutput,
      exitCode: 0,
    });
    assert.notInclude(imageCommand!.text, "AAECAw==");
    assert.include(imageCommand!.text, "image/png");
    assert.include(imageCommand!.text, "read screenshot.png");
    const native = nativeContextHistory(
      { runs: [], attempts: [], providerTurns: [], contextHandoffs: [] },
      providerThread,
    );
    native.nativeInputRunIds.add(base.runId);
    const nativePayload = "AAECAw==".repeat(4_096);
    assert.isAtLeast(
      native.estimate([
        {
          ...base,
          type: "dynamic_tool",
          toolName: "Read",
          input: { path: "screenshot.png" },
          output: { type: "image", data: nativePayload, mimeType: "image/png" },
        },
      ]),
      estimateTextTokens(nativePayload),
    );
    const fileChange = {
      ...base,
      type: "file_change",
      fileName: "src/a.ts",
      changes: [
        { operation: "update", path: "src/a.ts" },
        { operation: "add", path: "src/b.ts" },
        { operation: "update", path: "src/new.ts", oldPath: "src/old.ts" },
      ],
    } satisfies OrchestrationV2TurnItem;
    for (const path of ["src/a.ts", "src/b.ts", "src/new.ts"]) {
      assert.include(historicalMessage(fileChange)!.text, path);
    }
    assert.equal(
      historicalMessage({ ...fileChange, status: "running" })?.text,
      "File change: src/a.ts, src/b.ts, src/new.ts",
    );
    const evidence = [
      {
        item: {
          ...base,
          type: "dynamic_tool",
          toolName: "verify_health",
          input: { endpoint: "/health" },
          output: { failure: "Expected HTTP 200, received 503" },
        },
        text: "Expected HTTP 200, received 503",
      },
      {
        item: {
          ...base,
          type: "file_change",
          fileName: "src/health.ts",
          diffStr: "-return 503;\n+return 200;",
        },
        text: "+return 200;",
      },
      {
        item: {
          ...base,
          type: "file_search",
          pattern: "health",
          results: [{ fileName: "src/health.ts", line: 7, preview: "export const health = 200" }],
        },
        text: "export const health = 200",
      },
      {
        item: {
          ...base,
          type: "web_search",
          patterns: ["HTTP 503"],
          results: [{ url: "https://example.com/status/503", title: "Service unavailable" }],
        },
        text: "Service unavailable",
      },
      {
        item: {
          ...base,
          type: "subagent",
          subagentId: NodeId.make("node:health-check"),
          origin: "app_owned",
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          childThreadId: null,
          prompt: "Check the health endpoint",
          result: "The upstream service is unavailable",
        },
        text: "The upstream service is unavailable",
      },
    ] satisfies ReadonlyArray<{ item: OrchestrationV2TurnItem; text: string }>;
    for (const { item, text } of evidence) {
      const historical = historicalMessage(item);
      assert.isNotNull(
        historical,
        `${item.type} must be eligible for handoff and summary coverage`,
      );
      assert.include(historical!.text, text);
      assert.equal(historical!.kind, item.type);
      assert.equal(historical!.itemId, item.id);
      if (item.type === "dynamic_tool")
        assert.isNull(historicalMessage({ ...item, outputOmitted: true }));
    }
    assert.equal(
      historicalMessage({
        ...base,
        status: "running",
        type: "file_change",
        fileName: "src/a.ts",
        changes: [],
      })?.text,
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
        previousUsage: { usedTokens: 30_000, maxTokens: 32_000, autoCompactThreshold: 31_000 },
        knownModelWindow: 1_000_000,
      }),
      { usedTokens: 30_000, maxTokens: 1_000_000 },
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
  it.effect.each([true, false])(
    "reserves earlier summarized evidence in later budgets without native telemetry (inject=%s)",
    (native) =>
      Effect.gen(function* () {
        const coveredItemIds = Array.from({ length: 8 }, (_, index) =>
          TurnItemId.make(`item:summary-source-${index}`),
        );
        const tail: OrchestrationV2TurnItem = {
          id: TurnItemId.make("item:tail-command"),
          threadId,
          runId: RunId.make("run:source"),
          nodeId: null,
          providerThreadId: ProviderThreadId.make("provider-thread:source"),
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "command_execution",
          input: "vp test",
          output: "All tests passed.",
          exitCode: 0,
        };
        const source: OrchestrationV2ContextHandoff = {
          ...handoff,
          history: {
            messages: [historicalMessage(tail)!],
            coverage: "The original sources exceeded the preparation budget.",
            omittedItems: coveredItemIds.length,
            omittedItemIds: coveredItemIds,
          },
        };
        let durable = [source, { ...source, id: ContextHandoffId.make("handoff:overlap") }];
        let deliveredCost = 0;
        const deliver = () =>
          deliverContextHandoffs({
            handoffs: durable,
            providerThread,
            budget: 16_000,
            alreadyDeliveredItemIds: new Set(),
            summaries: () =>
              Effect.succeed([
                {
                  id: `summary:${"a".repeat(64)}`,
                  ...summaryScope,
                  coveredItemIds,
                  text: `Generated conversation summary with as-sent project evidence: ${"x".repeat(14_000)}`,
                },
              ]),
            inject: (input) => {
              deliveredCost = historyCost(input.messages, input.context);
              return Effect.succeed(native);
            },
            persist: (value) =>
              Effect.sync(() => {
                durable = durable.map((entry) => (entry.id === value.id ? value : entry));
              }),
          });
        const first = yield* deliver();
        assert.equal(
          nativeContextHistory(
            { runs: [], attempts: [], providerTurns: [], contextHandoffs: durable },
            providerThread,
          ).estimate([tail]),
          native ? deliveredCost : 0,
        );
        yield* first.delivered;
        assert.deepEqual(durable[0]?.delivery?.summarizedItemIds, coveredItemIds);
        assert.isAbove(deliveredCost, 14_000);
        const occupancy = (
          contextHandoffs: ReadonlyArray<OrchestrationV2ContextHandoff>,
          target = providerThread,
        ) =>
          nativeContextHistory(
            { runs: [], attempts: [], providerTurns: [], contextHandoffs },
            target,
          );
        const estimate = occupancy(durable.map((entry) => decodeHandoff(entry))).estimate([tail]);
        assert.equal(estimate, deliveredCost);
        const allowance = handoffBudget({
          tokenCap: 16_000,
          userText: "Continue",
          attachments: [],
          providerThread,
          nativeContextEstimate: estimate,
          modelContextWindow: 40_000,
        });
        assert.isAtMost(allowance + deliveredCost + 16_000, 40_000);
        const retry = yield* deliver();
        yield* retry.delivered;
        assert.equal(retry.context, "");
        assert.equal(occupancy(durable).estimate([tail]), deliveredCost);
        assert.equal(
          occupancy(
            durable.map((entry) => ({ ...entry, summaryText: "", history: undefined })),
          ).estimate([]),
          deliveredCost,
        );
        assert.equal(
          occupancy(durable, {
            ...providerThread,
            nativeThreadRef: { ...providerThread.nativeThreadRef!, nativeId: "replacement" },
          }).estimate([tail]),
          0,
        );
        const { estimatedTokens: _estimate, ...legacy } = durable[0]!.delivery!;
        assert.equal(
          occupancy([decodeHandoff({ ...source, delivery: legacy })]).estimate([tail]),
          estimateTextTokens(historicalMessage(tail)!.text),
        );
      }),
  );

  it.effect.each([true, false])(
    "uses a summary only when more history arrives with it than without it (native=%s)",
    (native) =>
      Effect.gen(function* () {
        const history = Array.from({ length: 30 }, (_, index) =>
          message(`item:h${index}`, index % 2 === 0 ? "user" : "assistant", "x".repeat(700)),
        );
        const source: OrchestrationV2ContextHandoff = {
          ...handoff,
          history: { messages: history, coverage: "Coverage.", omittedItems: 0 },
        };
        const ids = (from: number, to: number) =>
          history.slice(from, to + 1).map((entry) => entry.itemId);
        const deliver = Effect.fn("test.deliverWithSummaries")(function* (
          summaries: ReadonlyArray<{
            readonly id: `summary:${string}`;
            readonly projectId: ProjectId;
            readonly threadId: ThreadId;
            readonly coveredItemIds: ReadonlyArray<TurnItemId>;
            readonly text: string;
            readonly knowledgeFactIds?: ReadonlyArray<ProjectFactId>;
          }>,
        ) {
          let verbatim: ReadonlyArray<TurnItemId> = [];
          let context = "";
          let summarized: ReadonlyArray<TurnItemId> = [];
          let deliveredFactIds: ReadonlyArray<ProjectFactId> = [];
          const delivery = yield* deliverContextHandoffs({
            handoffs: [source],
            providerThread,
            budget: 16_000,
            alreadyDeliveredItemIds: new Set(),
            summaries: () => Effect.succeed(summaries),
            inject: (input) => {
              verbatim = input.messages.map((entry) => entry.itemId);
              context = input.context;
              return Effect.succeed(native);
            },
            onDelivered: (_messages, factIds) =>
              Effect.sync(() => {
                deliveredFactIds = factIds;
              }),
            persist: (value) =>
              Effect.sync(() => {
                summarized = value.delivery?.summarizedItemIds ?? [];
              }),
          });
          if (!native) assert.deepEqual(deliveredFactIds, []);
          yield* delivery.delivered;
          return {
            represented: new Set([...verbatim, ...summarized]),
            verbatim,
            summarized,
            context,
            summaryFactIds: delivery.summaryFactIds,
            deliveredFactIds,
          };
        });
        const baseline = yield* deliver([]);
        const old = {
          id: `summary:${"a".repeat(64)}` as const,
          ...summaryScope,
          coveredItemIds: ids(1, 8),
          text: `OLD ${"o".repeat(8_000)}`,
          knowledgeFactIds: [ProjectFactId.make("fact:old")],
        };
        const withOld = yield* deliver([old]);
        assert.deepEqual(
          [...baseline.represented].filter((id) => !withOld.represented.has(id)),
          [],
          "history that fit without summaries must still arrive",
        );
        const recent = {
          id: `summary:${"b".repeat(64)}` as const,
          ...summaryScope,
          coveredItemIds: ids(16, 23),
          text: `RECENT ${"r".repeat(1_200)}`,
          knowledgeFactIds: [ProjectFactId.make("fact:recent")],
        };
        const chained = yield* deliver([recent, old]);
        assert.deepEqual(chained.summarized, ids(16, 23));
        assert.include(chained.context, "RECENT");
        assert.deepEqual(
          [...baseline.represented].filter((id) => !chained.represented.has(id)),
          [],
        );
        assert.isAbove(chained.represented.size, baseline.represented.size);
        assert.deepEqual(baseline.summaryFactIds, []);
        assert.deepEqual(withOld.summaryFactIds, []);
        assert.deepEqual(chained.summaryFactIds, recent.knowledgeFactIds);
        assert.deepEqual(chained.deliveredFactIds, recent.knowledgeFactIds);
        for (const delivery of [baseline, withOld, chained])
          assert.includeMembers([...delivery.verbatim], ids(24, 29), "the six newest messages");
      }),
  );

  it.effect("keeps the newest messages ahead of tool results, with or without a summary", () =>
    Effect.gen(function* () {
      const tool = (id: string): OrchestrationV2HistoricalMessage => ({
        ...message(id, "assistant", "t".repeat(1_500)),
        kind: "command_execution",
      });
      const older = Array.from({ length: 20 }, (_, index) =>
        message(`item:o${index}`, index % 2 === 0 ? "user" : "assistant", "o".repeat(700)),
      );
      // The oldest of the six newest messages is large and sits behind five tool results.
      const tail = [
        message("item:m1", "assistant", "m".repeat(2_000)),
        tool("item:t1"),
        message("item:m2", "user", "m".repeat(300)),
        tool("item:t2"),
        message("item:m3", "assistant", "m".repeat(300)),
        tool("item:t3"),
        message("item:m4", "user", "m".repeat(300)),
        tool("item:t4"),
        message("item:m5", "assistant", "m".repeat(300)),
        tool("item:t5"),
        message("item:m6", "user", "m".repeat(300)),
      ];
      const history = [...older, ...tail];
      const source: OrchestrationV2ContextHandoff = {
        ...handoff,
        history: { messages: history, coverage: "Coverage.", omittedItems: 0 },
      };
      const newest = ["m1", "m2", "m3", "m4", "m5", "m6"].map((id) =>
        TurnItemId.make(`item:${id}`),
      );
      let verbatim: ReadonlyArray<TurnItemId> = [];
      let summarized: ReadonlyArray<TurnItemId> = [];
      yield* deliverContextHandoffs({
        handoffs: [source],
        providerThread,
        // Room for the first request and the whole tail, and little else.
        budget: historyCost([older[0]!, ...tail], "c".repeat(600)) + 200,
        alreadyDeliveredItemIds: new Set(),
        summaries: () =>
          Effect.succeed([
            {
              id: `summary:${"c".repeat(64)}` as const,
              ...summaryScope,
              coveredItemIds: older.slice(1).map((entry) => entry.itemId),
              text: `OLDER ${"s".repeat(1_600)}`,
            },
          ]),
        inject: (input) => {
          verbatim = input.messages.map((entry) => entry.itemId);
          return Effect.succeed(true);
        },
        persist: (value) =>
          Effect.sync(() => {
            summarized = value.delivery?.summarizedItemIds ?? [];
          }),
      });
      assert.includeMembers([...verbatim], newest, "the six newest messages");
      assert.lengthOf(summarized, 19, "the summary of older history is delivered");

      // Without a summary to offer, the tool result next to the oldest tail message gives way.
      const unsummarized = yield* deliverContextHandoffs({
        handoffs: [source],
        providerThread: { ...providerThread, nativeThreadRef: null },
        budget: historyCost(
          [older[0]!, ...tail.filter((entry) => entry !== tail[1])],
          "c".repeat(600),
        ),
        alreadyDeliveredItemIds: new Set(),
        persist: () => Effect.void,
      });
      assert.includeMembers(
        unsummarized.messages.map((entry) => entry.itemId),
        newest,
        "the six newest messages without a summary",
      );
    }),
  );

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

  it.effect("renders as-sent evidence with its message once, within budget, and not on retry", () =>
    Effect.gen(function* () {
      let durable = handoff;
      const evidenceRequests: Array<ReadonlyArray<string>> = [];
      const viewed: Array<ReadonlyArray<string>> = [];
      const injected: Array<ProviderAdapter.ProviderAdapterV2HistoricalContext> = [];
      const input = {
        providerThread,
        budget: 2_500,
        alreadyDeliveredItemIds: new Set<string>(),
        evidence: (candidates: ReadonlyArray<OrchestrationV2HistoricalMessage>) =>
          Effect.sync(() => {
            evidenceRequests.push(candidates.map((candidate) => candidate.itemId));
            return new Map([["item:one", "AS-SENT EXCERPT"]]);
          }),
        onDelivered: (selected: ReadonlyArray<OrchestrationV2HistoricalMessage>) =>
          Effect.sync(() => {
            viewed.push(selected.map((candidate) => candidate.itemId));
          }),
        inject: (value: ProviderAdapter.ProviderAdapterV2HistoricalContext) =>
          Effect.sync(() => {
            injected.push(value);
            return true;
          }),
        persist: (value: OrchestrationV2ContextHandoff) =>
          Effect.sync(() => {
            durable = value;
          }),
      };
      yield* deliverContextHandoffs({ ...input, handoffs: [durable, durable] });
      const serialized = yield* encodeJson(
        historyResponseItems(injected[0]!.messages, injected[0]!.context),
      );
      assert.equal(serialized.split("AS-SENT EXCERPT").length - 1, 1);
      assert.equal(
        injected[0]!.messages.find((item) => item.itemId === "item:one")?.text,
        `${messages[0]!.text}\n\nAS-SENT EXCERPT`,
      );
      assert.isAtMost(historyCost(injected[0]!.messages, injected[0]!.context), 2_500);
      assert.equal(durable.history?.messages[0]?.text, messages[0]!.text);
      yield* deliverContextHandoffs({ ...input, handoffs: [durable] });
      assert.lengthOf(injected, 1);
      assert.deepEqual(evidenceRequests, [["item:one", "item:two"]]);
      assert.deepEqual(viewed, [["item:one", "item:two"]]);

      // A native conversation that already holds the message never asks for its evidence.
      const { inject: _inject, ...inline } = input;
      const fresh = yield* deliverContextHandoffs({
        ...inline,
        handoffs: [handoff],
        alreadyDeliveredItemIds: new Set(["item:one"]),
      });
      assert.notInclude(fresh.context, "AS-SENT EXCERPT");
      assert.deepEqual(evidenceRequests.at(-1), ["item:two"]);
      assert.lengthOf(viewed, 1);
      yield* fresh.delivered;
      assert.deepEqual(viewed.at(-1), ["item:two"]);

      const oversized = yield* deliverContextHandoffs({
        ...inline,
        handoffs: [handoff],
        evidence: () => Effect.succeed(new Map([["item:one", "x".repeat(5_000)]])),
      });
      assert.notInclude(oversized.context, messages[0]!.text);
      assert.include(oversized.context, "Partial work");
      assert.lengthOf(viewed, 2);
      yield* oversized.delivered;
      assert.deepEqual(viewed.at(-1), ["item:two"]);

      const deferred = yield* deliverContextHandoffs({
        ...input,
        handoffs: [handoff],
        deferInline: true,
        inject: () => Effect.succeed(false),
      });
      yield* deferred.delivered;
      assert.lengthOf(viewed, 3);
    }),
  );

  it.effect.each([
    { name: "nothing omitted", history: handoff.history!, summaryText: "", uncovered: 0 },
    {
      name: "omitted items an older record does not name",
      history: { ...handoff.history!, omittedItems: 3 },
      summaryText: "",
      uncovered: 3,
    },
    {
      name: "named omitted items",
      history: {
        ...handoff.history!,
        omittedItems: 2,
        omittedItemIds: [TurnItemId.make("item:gone-1"), TurnItemId.make("item:gone-2")],
      },
      summaryText: "",
      uncovered: 2,
    },
    {
      name: "a record without history whose text does not fit",
      history: undefined,
      summaryText: "x".repeat(70_000),
      uncovered: 1,
    },
  ])("counts what a delivery leaves uncovered: $name", ({ history, summaryText, uncovered }) =>
    Effect.gen(function* () {
      const { history: _, ...rest } = handoff;
      const result = yield* deliverContextHandoffs({
        handoffs: [{ ...rest, summaryText, ...(history === undefined ? {} : { history }) }],
        providerThread: { ...providerThread, nativeThreadRef: null },
        budget: 64_000,
        alreadyDeliveredItemIds: new Set(),
        persist: () => Effect.void,
      });
      assert.equal(result.uncoveredItems, uncovered);
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

  const summaryId = `summary:${"a".repeat(64)}` as const;
  const summaryTools = "t3_conversation_summary_list and t3_conversation_summary_expand";

  it.effect("names the summaries a delivery sent in the receipt, not in the prompt", () =>
    Effect.gen(function* () {
      const history = Array.from({ length: 30 }, (_, index) =>
        message(`item:receipt-${index}`, index % 2 === 0 ? "user" : "assistant", "x".repeat(700)),
      );
      const covered = history.slice(16, 24).map((entry) => entry.itemId);
      const source: OrchestrationV2ContextHandoff = {
        ...handoff,
        id: ContextHandoffId.make("handoff:summary-receipt"),
        summaryText: [
          "Coverage.",
          `Some omitted items have conversation summaries; read one with ${summaryTools}.`,
        ].join("\n"),
        history: { messages: history, coverage: "Coverage.", omittedItems: 0 },
      };
      let durable = source;
      let context = "";
      const delivery = yield* deliverContextHandoffs({
        handoffs: [source],
        providerThread,
        budget: 16_000,
        alreadyDeliveredItemIds: new Set(),
        summaries: () =>
          Effect.succeed([
            {
              id: summaryId,
              ...summaryScope,
              coveredItemIds: covered,
              text: `RECENT ${"r".repeat(1_200)}`,
            },
          ]),
        inject: (input) => {
          context = input.context;
          return Effect.succeed(true);
        },
        persist: (value) =>
          Effect.sync(() => {
            durable = value;
          }),
      });
      yield* delivery.delivered;
      const line = `Replaced earlier spans with ${summaryId}; read one with ${summaryTools}.`;
      assert.deepEqual(durable.delivery?.summaryIds, [summaryId]);
      assert.equal(durable.summaryText, `Coverage.\n${line}`);
      assert.notInclude(durable.summaryText, "RECENT");
      // The delivered summary's own header names it and how to expand it.
      assert.include(context, "RECENT");
      assert.notInclude(context, "Replaced earlier spans");
      assert.notInclude(context, "Not shown here");
    }),
  );

  it.effect("points at the summary holding an omitted tool result that was not sent", () =>
    Effect.gen(function* () {
      const omitted: OrchestrationV2HistoricalMessage = {
        ...message("item:receipt-omitted", "assistant", `Command: vp test\n${"o".repeat(20_000)}`),
        kind: "command_execution",
      };
      const kept = message("item:receipt-kept", "user", "kept");
      const source: OrchestrationV2ContextHandoff = {
        ...handoff,
        id: ContextHandoffId.make("handoff:omitted-summary"),
        summaryText: "Coverage.",
        history: {
          messages: [omitted, kept],
          coverage: "Coverage.",
          omittedItems: 0,
        },
      };
      let durable = source;
      let context = "";
      const delivery = yield* deliverContextHandoffs({
        handoffs: [source],
        providerThread,
        budget: 8_000,
        alreadyDeliveredItemIds: new Set(),
        summaries: () =>
          Effect.succeed([
            {
              id: summaryId,
              ...summaryScope,
              coveredItemIds: [omitted.itemId],
              text: "S".repeat(40_000),
            },
          ]),
        inject: (input) => {
          context = input.context;
          return Effect.succeed(false);
        },
        persist: (value) =>
          Effect.sync(() => {
            durable = value;
          }),
      });
      yield* delivery.delivered;
      const line = `Some omitted items have conversation summaries; read one with ${summaryTools}.`;
      assert.isUndefined(durable.delivery?.summaryIds);
      assert.isAbove(delivery.uncoveredItems, 0);
      assert.equal(durable.summaryText, `Coverage.\n${line}`);
      assert.notInclude(durable.summaryText, summaryId);
      assert.include(
        context,
        `Not shown here: item:receipt-omitted (command_execution: Command: vp test). ${summaryId} holds the original text; read it with t3_conversation_summary_expand({projectId:"project:handoff",threadId:"thread:handoff",summaryId:"${summaryId}"}).`,
      );
      assert.notInclude(context, "SSSS");
    }),
  );

  const listCall = `t3_conversation_summary_list({projectId:"project:handoff",threadId:"thread:handoff"})`;
  it.effect.each([
    {
      budget: 6_000,
      tailCount: 0,
      grows: false,
      shown: ["item:many-19", "item:many-18", "item:many-17"],
      line: `17 more summaries hold omitted items; list them with ${listCall}.`,
    },
    {
      budget: 1_400,
      tailCount: 0,
      grows: false,
      shown: [],
      line: `Not shown here: 20 conversation summaries hold omitted items; list them with ${listCall}.`,
    },
    {
      budget: 16_000,
      tailCount: 50,
      grows: false,
      shown: [],
      line: `Not shown here: 20 conversation summaries hold omitted items; list them with ${listCall}.`,
    },
    {
      budget: 3_448,
      tailCount: 50,
      grows: true,
      shown: [],
      line: `Not shown here: 10 conversation summaries hold omitted items; list them with ${listCall}.`,
    },
  ])(
    "still points at unsent summaries when their lines do not all fit: $budget",
    ({ budget, tailCount, grows, shown, line }) =>
      Effect.gen(function* () {
        const indexText = (index: number) => (grows ? String(index).padStart(2, "0") : index);
        const tools = Array.from({ length: grows ? 30 : 20 }, (_, index) => ({
          ...message(
            `item:many-${indexText(index)}`,
            "assistant",
            `Command: step ${index}\n${"o".repeat(8_000)}`,
          ),
          kind: "command_execution" as const,
        }));
        const tail =
          tailCount === 0
            ? [message("item:many-kept", "user", "kept")]
            : Array.from({ length: tailCount }, (_, index) =>
                message(
                  `item:tail-${indexText(index)}`,
                  index % 2 === 0 ? "user" : "assistant",
                  "k".repeat(grows ? 1 : 64),
                ),
              );
        const idFor = (index: number) => `summary:${index.toString(16).padStart(64, "0")}`;
        const source: OrchestrationV2ContextHandoff = {
          ...handoff,
          id: ContextHandoffId.make("handoff:many-unsent"),
          summaryText: "Coverage.",
          history: {
            messages: [...tools, ...tail],
            coverage: "Coverage.",
            omittedItems: 0,
          },
        };
        let injected = {
          messages: [] as ReadonlyArray<OrchestrationV2HistoricalMessage>,
          context: "",
        };
        const delivery = yield* deliverContextHandoffs({
          handoffs: [source],
          providerThread,
          budget,
          alreadyDeliveredItemIds: new Set(),
          summaries: () =>
            Effect.succeed(
              (grows ? [...tools.slice(0, 9), tail[41]!] : tools.toReversed()).map(
                (tool, index) => ({
                  id: idFor(grows ? index : 19 - index),
                  ...summaryScope,
                  coveredItemIds: [tool.itemId],
                  text: "S".repeat(40_000),
                }),
              ),
            ),
          inject: (input) => {
            injected = input;
            return Effect.succeed(false);
          },
          persist: () => Effect.void,
        });
        yield* delivery.delivered;
        assert.include(injected.context, line);
        assert.includeMembers(
          injected.messages.map((entry) => entry.itemId),
          tail.slice(-6).map((entry) => entry.itemId),
        );
        for (const index of [19, 18, 17, 16]) {
          const named = `${idFor(index)} holds`;
          if (shown.includes(`item:many-${index}`)) assert.include(injected.context, named);
          else assert.notInclude(injected.context, named);
        }
        assert.isAtMost(historyCost(injected.messages, injected.context), budget);
      }),
  );

  it.effect(
    "replaces the receipt when the same handoff is delivered again with a different summary",
    () =>
      Effect.gen(function* () {
        const history = Array.from({ length: 30 }, (_, index) =>
          message(
            `item:redeliver-${index}`,
            index % 2 === 0 ? "user" : "assistant",
            "x".repeat(700),
          ),
        );
        const firstId = `summary:${"c".repeat(64)}` as const;
        const secondId = `summary:${"d".repeat(64)}` as const;
        let durable: OrchestrationV2ContextHandoff = {
          ...handoff,
          id: ContextHandoffId.make("handoff:redeliver"),
          summaryText: "Coverage.",
          history: { messages: history, coverage: "Coverage.", omittedItems: 0 },
        };
        const deliver = (
          summaryId: typeof firstId,
          covered: ReadonlyArray<TurnItemId>,
          nativeId: string,
        ) =>
          Effect.gen(function* () {
            const delivery = yield* deliverContextHandoffs({
              handoffs: [durable],
              providerThread: {
                ...providerThread,
                nativeThreadRef: {
                  driver: ProviderDriverKind.make("codex"),
                  strength: "strong",
                  nativeId,
                },
              },
              budget: 16_000,
              alreadyDeliveredItemIds: new Set(),
              summaries: () =>
                Effect.succeed([
                  {
                    id: summaryId,
                    ...summaryScope,
                    coveredItemIds: covered,
                    text: `OFFER ${"r".repeat(1_200)}`,
                  },
                ]),
              inject: () => Effect.succeed(true),
              persist: (value) =>
                Effect.sync(() => {
                  durable = value;
                }),
            });
            yield* delivery.delivered;
          });
        yield* deliver(
          firstId,
          history.slice(4, 12).map((entry) => entry.itemId),
          "native:first",
        );
        assert.deepEqual(durable.delivery?.summaryIds, [firstId]);
        yield* deliver(
          secondId,
          history.slice(16, 24).map((entry) => entry.itemId),
          "native:second",
        );
        const line = `Replaced earlier spans with ${secondId}; read one with ${summaryTools}.`;
        assert.equal(durable.summaryText, `Coverage.\n${line}`);
        assert.deepEqual(durable.delivery?.summaryIds, [secondId]);
        assert.notInclude(durable.summaryText, firstId);
      }),
  );
});
