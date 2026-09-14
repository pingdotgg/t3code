import { describe, it, expect } from "@effect/vitest";
import { splitBufferedAssistantText, makeAssistantEventDelivery } from "./assistantStreaming.ts";
import { MessageId, NodeId, ProviderDriverKind, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { ProviderAdapterV2Event } from "./ProviderAdapter.ts";

describe("splitBufferedAssistantText", () => {
  it("keeps a partial trailing line buffered", () => {
    expect(splitBufferedAssistantText("one\n\ntwo")).toEqual({ ready: "one\n\n", rest: "two" });
    expect(splitBufferedAssistantText("one\ntwo")).toEqual({ ready: "", rest: "one\ntwo" });
  });

  it("does not split inside an open fence and delivers the block at its closing fence", () => {
    const open = "intro\n\n```\ncode\n\nmore\n";
    expect(splitBufferedAssistantText(open)).toEqual({
      ready: "intro\n\n",
      rest: "```\ncode\n\nmore\n",
    });
    expect(splitBufferedAssistantText(`${open}\`\`\`\nafter`)).toEqual({
      ready: `${open}\`\`\`\n`,
      rest: "after",
    });
  });

  it("does not treat a fence with an info string as a closing fence", () => {
    const text = "```\n```javascript\nstill code\n\nmore\n";
    expect(splitBufferedAssistantText(text)).toEqual({ ready: "", rest: text });
  });

  it("treats a fence indented four or more spaces as code, not a closing fence", () => {
    const text = "```\n    ```\n\nstill code\n";
    expect(splitBufferedAssistantText(text)).toEqual({ ready: "", rest: text });
    expect(splitBufferedAssistantText("```\n   ```\nafter")).toEqual({
      ready: "```\n   ```\n",
      rest: "after",
    });
  });

  it("keeps a fence nested under a list item open across its blank lines", () => {
    const text = "- step\n\n    ```ts\n    a\n\n    b\n    ```\n\nafter\n";
    expect(splitBufferedAssistantText(text)).toEqual({
      ready: "- step\n\n    ```ts\n    a\n\n    b\n    ```\n\n",
      rest: "after\n",
    });
  });

  it("does not treat a no-break-space line as blank", () => {
    expect(splitBufferedAssistantText("para\n\u00a0\ncont\n\nnext")).toEqual({
      ready: "para\n\u00a0\ncont\n\n",
      rest: "next",
    });
  });

  it("treats CRLF blank lines as boundaries", () => {
    expect(splitBufferedAssistantText("one\r\n\r\ntwo")).toEqual({
      ready: "one\r\n\r\n",
      rest: "two",
    });
  });

  it("only closes a fence with the same marker of equal or greater length", () => {
    const text = "````\n```\nstill code\n\n````\n\nout\n";
    expect(splitBufferedAssistantText(text)).toEqual({
      ready: "````\n```\nstill code\n\n````\n\n",
      rest: "out\n",
    });
    expect(splitBufferedAssistantText("~~~\n```\n\nx\n")).toEqual({
      ready: "",
      rest: "~~~\n```\n\nx\n",
    });
  });
});

const update = (text: string, streaming = true): ProviderAdapterV2Event => ({
  type: "turn_item.updated",
  driver: ProviderDriverKind.make("codex"),
  turnItem: {
    id: TurnItemId.make("item"),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: NodeId.make("node"),
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: streaming ? "running" : "completed",
    title: "Answer",
    startedAt: DateTime.makeUnsafe(0),
    completedAt: null,
    updatedAt: DateTime.makeUnsafe(0),
    type: "assistant_message",
    messageId: MessageId.make("message"),
    text,
    streaming,
  },
});
it("publishes stable paragraphs once and flushes the incomplete tail at completion", () => {
  const deliver = makeAssistantEventDelivery("paragraph");
  expect(deliver(update("Hello"))).toBeUndefined();
  expect(deliver(update("Hello\n\nPartial"))).toMatchObject({
    turnItem: { text: "Hello\n\n", streaming: true },
  });
  expect(deliver(update("Hello\n\nPartial code"))).toBeUndefined();
  expect(deliver(update("Hello\n\nPartial code", false))).toMatchObject({
    turnItem: { text: "Hello\n\nPartial code", streaming: false },
  });
});
it("preserves token and completed-turn delivery modes", () => {
  const partial = update("partial");
  expect(makeAssistantEventDelivery("token")(partial)).toBe(partial);
  const deliver = makeAssistantEventDelivery("turn");
  expect(deliver(partial)).toBeUndefined();
  const final = update("final", false);
  expect(deliver(final)).toBe(final);
});
