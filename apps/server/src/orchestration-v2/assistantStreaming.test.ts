import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { assert, describe, expect, it } from "vite-plus/test";
import { makeAssistantStreamingFilter, splitBufferedAssistantText } from "./assistantStreaming.ts";

describe("V2 assistant streaming", () => {
  it("keeps code fences intact", () => {
    expect(splitBufferedAssistantText("Intro\n\n```ts\nx()\n\n")).toEqual({
      ready: "Intro\n\n",
      rest: "```ts\nx()\n\n",
    });
    expect(splitBufferedAssistantText("```ts\nx()\n```\nrest")).toEqual({
      ready: "```ts\nx()\n```\n",
      rest: "rest",
    });
  });
});

it("holds a streamed section heading until its content has a boundary", () => {
  expect(splitBufferedAssistantText("Intro\n\n## Results\n\n")).toEqual({
    ready: "Intro\n\n",
    rest: "## Results\n\n",
  });
  expect(splitBufferedAssistantText("**Results**\n\nBody\n\nNext")).toEqual({
    ready: "**Results**\n\nBody\n\n",
    rest: "Next",
  });
});

it("delivers held text once idle, never after its final, and never in turn mode", () => {
  const snapshot = (text: string, streaming = true) =>
    ({
      type: "turn_item.updated",
      turnItem: { id: "item", type: "reasoning", text, streaming },
    }) as unknown as ProviderAdapter.ProviderAdapterV2Event;
  const text = (event: ProviderAdapter.ProviderAdapterV2Event | undefined) =>
    event?.type === "turn_item.updated" && "text" in event.turnItem ? event.turnItem.text : null;
  // Flushes everything due and reports what it delivered.
  const flush = (filter: ReturnType<typeof makeAssistantStreamingFilter>, now: number) =>
    filter.dueIdleFlushes(now).map((due) => {
      due.delivered(now);
      return text(due.event);
    });

  const paragraph = makeAssistantStreamingFilter("paragraph", 800);
  assert.equal(text(paragraph.filter(snapshot("A\n\n```ts\nx()"), 0) ?? undefined), "A\n\n");
  // Inside the 400ms throttle even though a boundary is ready.
  assert.isNull(paragraph.filter(snapshot("A\n\n```ts\nx()\n```\n\nB"), 100));
  assert.equal(paragraph.nextIdleFlushAt(), 900);
  assert.deepEqual(flush(paragraph, 899), []);
  // A failed write keeps the snapshot held until its retry time.
  paragraph.dueIdleFlushes(900)[0]?.retryAt(1_900);
  assert.equal(paragraph.nextIdleFlushAt(), 1_900);
  assert.deepEqual(flush(paragraph, 1_899), []);
  assert.deepEqual(flush(paragraph, 1_900), ["A\n\n```ts\nx()\n```\n\nB"]);
  assert.isNull(paragraph.nextIdleFlushAt());

  paragraph.filter(snapshot("A\n\n```ts\nx()\n```\n\nB and C"), 2_500);
  const superseded = paragraph.dueIdleFlushes(3_300);
  assert.isNotNull(paragraph.filter(snapshot("A\n\n```ts\nx()\n```\n\nB and C.", false), 3_400));
  // An outcome for a snapshot the final replaced changes nothing.
  superseded[0]?.retryAt(3_500);
  assert.isNull(paragraph.nextIdleFlushAt());
  assert.deepEqual(flush(paragraph, 5_000), []);

  // Provider rewrites replace delivered text: shorter at once, same-length after the throttle.
  const rewrite = makeAssistantStreamingFilter("paragraph", 800);
  assert.equal(
    text(rewrite.filter(snapshot("Original long paragraph.\n\n"), 0) ?? undefined),
    "Original long paragraph.\n\n",
  );
  assert.equal(text(rewrite.filter(snapshot("New.\n\n"), 1_000) ?? undefined), "New.\n\n");
  assert.isNull(rewrite.filter(snapshot("Old.\n\n"), 1_100));
  assert.deepEqual(flush(rewrite, 1_900), ["Old.\n\n"]);
  assert.isNull(rewrite.filter(snapshot("Old"), 2_500));
  assert.deepEqual(flush(rewrite, 3_300), ["Old"]);

  const turn = makeAssistantStreamingFilter("turn", 800);
  assert.isNull(turn.filter(snapshot("A\n\nB"), 0));
  assert.isNull(turn.nextIdleFlushAt());
});
