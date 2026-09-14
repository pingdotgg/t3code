import { describe, expect, it } from "vite-plus/test";
import { MessageId, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { makeAssistantStreamingFilter, splitBufferedAssistantText } from "./assistantStreaming.ts";
import type { ProviderAdapterV2Event } from "./ProviderAdapter.ts";

const message = (text: string, streaming = true): ProviderAdapterV2Event => ({
  type: "message.updated",
  driver: ProviderDriverKind.make("codex"),
  message: {
    id: MessageId.make("message"),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    createdBy: "agent",
    creationSource: "provider",
    updatedAt: DateTime.makeUnsafe("2026-09-14T00:00:00Z"),
    role: "assistant",
    text,
    attachments: [],
    createdAt: DateTime.makeUnsafe("2026-09-14T00:00:00Z"),
    streaming,
  },
});

describe("V2 assistant streaming", () => {
  it("delivers completed paragraphs, coalesces rapid updates, and flushes final text", () => {
    const filter = makeAssistantStreamingFilter("paragraph");
    expect(filter(message("First"), 0)).toBeNull();
    expect(filter(message("First\n\nSec"), 10)).toMatchObject({ message: { text: "First\n\n" } });
    expect(filter(message("First\n\nSecond\n\nThi"), 100)).toBeNull();
    expect(filter(message("First\n\nSecond\n\nThird"), 410)).toMatchObject({
      message: { text: "First\n\nSecond\n\n" },
    });
    const final = message("First\n\nSecond\n\nThird", false);
    expect(filter(final, 420)).toBe(final);
  });
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
  it("retains token and whole-turn delivery modes", () => {
    const running = message("partial");
    const final = message("complete", false);
    expect(makeAssistantStreamingFilter("token")(running, 0)).toBe(running);
    const buffered = makeAssistantStreamingFilter("turn");
    expect(buffered(running, 0)).toBeNull();
    expect(buffered(final, 1)).toBe(final);
  });
});
