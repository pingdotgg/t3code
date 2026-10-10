import { describe, expect, it } from "@effect/vitest";
import { RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import * as PromptSuggestions from "./PromptSuggestions.ts";

const threadId = ThreadId.make("thread-1");
const otherThreadId = ThreadId.make("thread-2");
const runId = RunId.make("run-1");
const suggestion = { id: "suggestion-1", runId, text: "Add a regression test" };

describe("PromptSuggestions", () => {
  it.effect("sends a late subscriber the current suggestion", () =>
    Effect.gen(function* () {
      const suggestions = yield* PromptSuggestions.make;
      yield* suggestions.publish(threadId, suggestion);

      const [current] = yield* suggestions.stream(threadId).pipe(Stream.take(1), Stream.runCollect);
      expect(current).toEqual(suggestion);
    }),
  );

  it.effect("streams a thread's own changes until its suggestion is cleared", () =>
    Effect.gen(function* () {
      const suggestions = yield* PromptSuggestions.make;
      yield* suggestions.publish(threadId, suggestion);
      const collected = yield* suggestions.stream(threadId).pipe(
        Stream.takeUntil((value) => value === null),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* suggestions.publish(otherThreadId, { id: "suggestion-2", runId, text: "Elsewhere" });
      yield* suggestions.publish(threadId, null);

      const values = yield* Fiber.join(collected);
      expect(values.at(-1)).toBeNull();
      expect(values.some((value) => value?.id === "suggestion-2")).toBe(false);
    }),
  );
});
