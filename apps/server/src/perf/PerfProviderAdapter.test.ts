import { afterEach, describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import { PERF_CATALOG_IDS } from "@t3tools/shared/perf/scenarioCatalog";

import { makePerfProviderAdapter } from "./PerfProviderAdapter.ts";

const PERF_SCENARIO_ENV = "T3CODE_PERF_SCENARIO";
const STREAM_SAMPLE_EVENT_COUNT = 96;

describe("PerfProviderAdapter", () => {
  const previousScenarioEnv = process.env[PERF_SCENARIO_ENV];

  afterEach(() => {
    if (previousScenarioEnv === undefined) {
      delete process.env[PERF_SCENARIO_ENV];
      return;
    }
    process.env[PERF_SCENARIO_ENV] = previousScenarioEnv;
  });

  it("emits canonical runtime events for the dense assistant stream scenario", async () => {
    process.env[PERF_SCENARIO_ENV] = "dense_assistant_stream";
    const adapter = await Effect.runPromise(makePerfProviderAdapter);
    const threadId = PERF_CATALOG_IDS.burstBase.burstThreadId;

    await Effect.runPromise(
      adapter.startSession({
        threadId,
        provider: "codex",
        runtimeMode: "full-access",
      }),
    );

    const firstEventsPromise = Effect.runPromise(
      Stream.runCollect(Stream.take(adapter.streamEvents, STREAM_SAMPLE_EVENT_COUNT)),
    );
    await Effect.runPromise(
      adapter.sendTurn({
        threadId,
        input: "exercise the dense perf scenario",
        attachments: [],
      }),
    );

    const firstEvents = Array.from(await firstEventsPromise);
    expect(firstEvents.filter((event) => event.type === "turn.started")).toHaveLength(3);
    expect(new Set(firstEvents.slice(0, 18).map((event) => String(event.threadId)))).toEqual(
      new Set([
        String(threadId),
        String(PERF_CATALOG_IDS.burstBase.navigationThreadId),
        String(PERF_CATALOG_IDS.burstBase.fillerThreadId),
      ]),
    );
    expect(
      firstEvents.some(
        (event) =>
          event.threadId === PERF_CATALOG_IDS.burstBase.navigationThreadId &&
          event.type === "content.delta" &&
          event.payload.delta.includes("Navigation lane"),
      ),
    ).toBe(true);
    expect(
      firstEvents.some(
        (event) =>
          event.threadId === threadId &&
          event.type === "item.completed" &&
          event.payload.itemType === "assistant_message",
      ),
    ).toBe(true);
    expect(
      firstEvents.some(
        (event) =>
          event.threadId === PERF_CATALOG_IDS.burstBase.fillerThreadId &&
          event.type === "item.updated" &&
          event.payload.itemType === "command_execution",
      ),
    ).toBe(true);

    const firstBurstFollowupCompletionIndex = firstEvents.findIndex(
      (event) =>
        event.threadId === threadId &&
        event.type === "item.completed" &&
        event.payload.itemType === "assistant_message" &&
        String(event.itemId ?? "").includes("followup"),
    );
    const burstWorklogIdsBeforeFollowup = new Set(
      firstEvents
        .slice(0, firstBurstFollowupCompletionIndex)
        .filter(
          (event) =>
            event.threadId === threadId &&
            event.type === "item.started" &&
            event.payload.itemType === "command_execution",
        )
        .map((event) => String(event.itemId)),
    );
    const burstAssistantMessageLengths = firstEvents
      .flatMap((event) => {
        if (
          event.threadId !== threadId ||
          event.type !== "item.completed" ||
          event.payload.itemType !== "assistant_message" ||
          event.payload.detail === undefined
        ) {
          return [];
        }
        return [event.payload.detail.length];
      })
      .slice(0, 4);

    expect(firstBurstFollowupCompletionIndex).toBeGreaterThan(0);
    expect(burstWorklogIdsBeforeFollowup.size).toBeGreaterThanOrEqual(3);
    expect(new Set(burstAssistantMessageLengths).size).toBeGreaterThan(1);
  });

  it("assigns fresh runtime ids when the same burst thread is sent twice", async () => {
    process.env[PERF_SCENARIO_ENV] = "dense_assistant_stream";
    const adapter = await Effect.runPromise(makePerfProviderAdapter);
    const threadId = PERF_CATALOG_IDS.burstBase.burstThreadId;

    await Effect.runPromise(
      adapter.startSession({
        threadId,
        provider: "codex",
        runtimeMode: "full-access",
      }),
    );

    const firstEventsPromise = Effect.runPromise(
      Stream.runCollect(Stream.take(adapter.streamEvents, STREAM_SAMPLE_EVENT_COUNT)),
    );
    await Effect.runPromise(
      adapter.sendTurn({
        threadId,
        input: "first dense perf pass",
        attachments: [],
      }),
    );

    const firstEvents = Array.from(await firstEventsPromise);

    const secondEventsPromise = Effect.runPromise(
      Stream.runCollect(Stream.take(adapter.streamEvents, STREAM_SAMPLE_EVENT_COUNT)),
    );
    await Effect.runPromise(
      adapter.sendTurn({
        threadId,
        input: "second dense perf pass",
        attachments: [],
      }),
    );

    const secondEvents = Array.from(await secondEventsPromise);

    const firstNavigationTurnStarted = firstEvents.find(
      (event) =>
        event.threadId === PERF_CATALOG_IDS.burstBase.navigationThreadId &&
        event.type === "turn.started",
    );
    const secondNavigationTurnStarted = secondEvents.find(
      (event) =>
        event.threadId === PERF_CATALOG_IDS.burstBase.navigationThreadId &&
        event.type === "turn.started",
    );
    const firstBurstAssistantCompletion = firstEvents.find(
      (event) =>
        event.threadId === threadId &&
        event.type === "item.completed" &&
        event.payload.itemType === "assistant_message",
    );
    const secondBurstAssistantCompletion = secondEvents.find(
      (event) =>
        event.threadId === threadId &&
        event.type === "item.completed" &&
        event.payload.itemType === "assistant_message",
    );
    const secondRunNamespaceSuffix = `--perf-run-${String(threadId)}-0002`;

    expect(firstNavigationTurnStarted?.turnId).toBe(PERF_CATALOG_IDS.provider.navigationLiveTurnId);
    expect(firstBurstAssistantCompletion?.itemId).toBeDefined();
    expect(secondNavigationTurnStarted?.turnId).toBeDefined();
    expect(secondBurstAssistantCompletion?.itemId).toBeDefined();
    expect(secondNavigationTurnStarted?.turnId).not.toBe(firstNavigationTurnStarted?.turnId);
    expect(secondBurstAssistantCompletion?.itemId).not.toBe(firstBurstAssistantCompletion?.itemId);
    expect(String(secondNavigationTurnStarted?.turnId)).toContain(secondRunNamespaceSuffix);
    expect(String(secondBurstAssistantCompletion?.itemId)).toContain(secondRunNamespaceSuffix);
  });
});
