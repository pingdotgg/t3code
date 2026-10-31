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

  const paragraph = makeAssistantStreamingFilter("paragraph", 800);
  assert.equal(text(paragraph.filter(snapshot("A\n\n```ts\nx()"), 0) ?? undefined), "A\n\n");
  // Inside the 400ms throttle even though a boundary is ready.
  assert.isNull(paragraph.filter(snapshot("A\n\n```ts\nx()\n```\n\nB"), 100));
  assert.equal(paragraph.nextIdleFlushAt(), 900);
  assert.deepEqual(paragraph.flushIdle(899), []);
  assert.equal(text(paragraph.flushIdle(900)[0]), "A\n\n```ts\nx()\n```\n\nB");
  assert.isNull(paragraph.nextIdleFlushAt());

  paragraph.filter(snapshot("A\n\n```ts\nx()\n```\n\nB and C"), 1_500);
  assert.equal(paragraph.nextIdleFlushAt(), 2_300);
  assert.isNotNull(paragraph.filter(snapshot("A\n\n```ts\nx()\n```\n\nB and C.", false), 1_600));
  assert.deepEqual(paragraph.flushIdle(5_000), []);

  const turn = makeAssistantStreamingFilter("turn", 800);
  assert.isNull(turn.filter(snapshot("A\n\nB"), 0));
  assert.isNull(turn.nextIdleFlushAt());
});
