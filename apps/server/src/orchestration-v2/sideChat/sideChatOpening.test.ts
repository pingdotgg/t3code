import { assert, describe, it } from "@effect/vitest";
import {
  type OrchestrationV2SideChatOpening,
  RunId,
  SIDE_CHAT_OPENING_WAIT_CAP_MS,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  awaitWithinSideChatWaitCap,
  owedSideChatSummary,
  sideChatLateSummaryHandoffId,
  sideChatOpeningHandoffId,
} from "./sideChatOpening.ts";
import { buildSideChatLateSummaryText, buildSideChatOpeningSummaryText } from "./sideChatText.ts";

describe("awaitWithinSideChatWaitCap", () => {
  it.effect("stops waiting for a side-chat opening at SIDE_CHAT_OPENING_WAIT_CAP_MS", () =>
    Effect.gen(function* () {
      const waiter = yield* awaitWithinSideChatWaitCap(Effect.never).pipe(Effect.forkChild);
      yield* TestClock.adjust(SIDE_CHAT_OPENING_WAIT_CAP_MS - 1);
      assert.isUndefined(waiter.pollUnsafe());

      yield* TestClock.adjust(1);
      assert.isFalse(yield* Fiber.join(waiter));
    }),
  );

  it.effect("stops waiting as soon as the opening settles", () =>
    Effect.gen(function* () {
      const settled = yield* Deferred.make<void>();
      const waiter = yield* awaitWithinSideChatWaitCap(Deferred.await(settled)).pipe(
        Effect.forkChild,
      );
      yield* Deferred.succeed(settled, undefined);
      assert.isTrue(yield* Fiber.join(waiter));
    }),
  );
});

describe("owedSideChatSummary", () => {
  const summary = "LESSON SUMMARY";
  const opening = (
    status: OrchestrationV2SideChatOpening["status"],
  ): OrchestrationV2SideChatOpening => ({
    status,
    text: status === "ready" ? summary : null,
    requestId: "command-side-chat-open",
  });
  const firstRun = RunId.make("run-1");
  const secondRun = RunId.make("run-2");
  const openingText = (status: OrchestrationV2SideChatOpening["status"]) =>
    buildSideChatOpeningSummaryText({
      opening: opening(status),
      excerpt: "observation space",
      excerptContext: "",
      lessonTopic: "Teach me RL environments.",
      parentOpeningText: null,
    });
  const fallbackOpening = {
    id: sideChatOpeningHandoffId(firstRun),
    targetRunId: firstRun,
    summaryText: openingText("pending"),
  };
  const openingWithSummary = { ...fallbackOpening, summaryText: openingText("ready") };
  const lateSummary = {
    id: sideChatLateSummaryHandoffId(secondRun),
    targetRunId: secondRun,
    summaryText: buildSideChatLateSummaryText(summary),
  };

  it("is owed once the summary lands after a fallback opening went out", () => {
    assert.equal(owedSideChatSummary(opening("ready"), [fallbackOpening]), summary);
  });

  it.each([
    { name: "no context went out yet", status: "ready", handoffs: [] },
    { name: "the opening carried it", status: "ready", handoffs: [openingWithSummary] },
    { name: "it was sent late already", status: "ready", handoffs: [fallbackOpening, lateSummary] },
    { name: "it is still being written", status: "pending", handoffs: [fallbackOpening] },
    { name: "it failed", status: "failed", handoffs: [fallbackOpening] },
    { name: "the writer gave none", status: "fallback", handoffs: [fallbackOpening] },
  ] as const)("is not owed when $name", ({ status, handoffs }) => {
    assert.isNull(owedSideChatSummary(opening(status), handoffs));
  });
});
