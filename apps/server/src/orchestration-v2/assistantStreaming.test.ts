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

it("delivers held text once idle without shrinking it, and never in turn mode", () => {
  const snapshot = (text: string) =>
    ({
      type: "turn_item.updated",
      turnItem: { id: "item", type: "reasoning", text, streaming: true },
    }) as unknown as ProviderAdapter.ProviderAdapterV2Event;
  const text = (event: ProviderAdapter.ProviderAdapterV2Event | null | undefined) =>
    event?.type === "turn_item.updated" && "text" in event.turnItem ? event.turnItem.text : null;
  const flush = (filter: ReturnType<typeof makeAssistantStreamingFilter>, now: number) =>
    filter.takeIdleFlushes(now).map(text);

  const paragraph = makeAssistantStreamingFilter("paragraph", 800);
  assert.equal(text(paragraph.filter(snapshot("A\n\n```ts\nx()"), 0)), "A\n\n");
  // Inside the 400ms throttle even though a boundary is ready.
  assert.isNull(paragraph.filter(snapshot("A\n\n```ts\nx()\n```\n\nB"), 100));
  assert.deepEqual(flush(paragraph, 899), []);
  assert.equal(paragraph.nextIdleFlushAt(), 900);
  assert.deepEqual(flush(paragraph, 900), ["A\n\n```ts\nx()\n```\n\nB"]);
  assert.isNull(paragraph.nextIdleFlushAt());
  // The next boundary is behind what the idle delivery showed.
  assert.isNull(paragraph.filter(snapshot("A\n\n```ts\nx()\n```\n\nB and C"), 2_500));

  // Provider rewrites replace delivered text: shorter at once, same-length after the throttle.
  const rewrite = makeAssistantStreamingFilter("paragraph", 800);
  assert.equal(
    text(rewrite.filter(snapshot("Original long paragraph.\n\n"), 0)),
    "Original long paragraph.\n\n",
  );
  assert.equal(text(rewrite.filter(snapshot("New.\n\n"), 1_000)), "New.\n\n");
  assert.isNull(rewrite.filter(snapshot("Old.\n\n"), 1_100));
  assert.deepEqual(flush(rewrite, 1_900), ["Old.\n\n"]);
  assert.isNull(rewrite.filter(snapshot("Old"), 2_500));
  assert.deepEqual(flush(rewrite, 3_300), ["Old"]);

  const turn = makeAssistantStreamingFilter("turn", 800);
  assert.isNull(turn.filter(snapshot("A\n\nB"), 0));
  assert.isNull(turn.nextIdleFlushAt());
});
