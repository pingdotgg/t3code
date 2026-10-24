import { MessageId, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { DateTime } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";
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

const assistantUpdate = (text: string): ProviderAdapter.ProviderAdapterV2Event => ({
  type: "message.updated",
  driver: ProviderDriverKind.make("codex"),
  message: {
    createdBy: "agent",
    creationSource: "provider",
    id: MessageId.make("message-1"),
    threadId: ThreadId.make("thread-1"),
    runId: null,
    nodeId: null,
    role: "assistant",
    text,
    attachments: [],
    streaming: true,
    createdAt: DateTime.makeUnsafe(0),
    updatedAt: DateTime.makeUnsafe(0),
  },
});

it("rescans a streamed reply the provider replaces", () => {
  const filter = makeAssistantStreamingFilter("paragraph");
  expect(filter(assistantUpdate("Intro\n\n```ts\nx()\n"), 0)).toMatchObject({
    message: { text: "Intro\n\n" },
  });
  expect(filter(assistantUpdate("Retry\n\n- a\n- b"), 400)).toMatchObject({
    message: { text: "Retry\n\n- a\n" },
  });
});

it("scans each streamed line once while a long code fence is still open", () => {
  const filter = makeAssistantStreamingFilter("paragraph");
  const lineCount = 400;
  let text = "Intro\n\n```ts\n";
  const indexOf = vi.spyOn(String.prototype, "indexOf");
  try {
    for (let line = 0; line < lineCount; line++) {
      text += `const value${line} = ${line};\n`;
      filter(assistantUpdate(text), line * 400);
    }
    const newlineSearches = indexOf.mock.calls.filter(([search]) => search === "\n").length;
    expect(newlineSearches).toBeLessThan(lineCount * 4);
  } finally {
    indexOf.mockRestore();
  }
  text += "```\n";
  expect(filter(assistantUpdate(text), lineCount * 400)).toMatchObject({ message: { text } });
});
