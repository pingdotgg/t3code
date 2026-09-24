import {
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationMessage,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import { ThreadFollowRenderer, webSocketUrlForOrigin } from "./threadFollow.ts";

const THREAD = ThreadId.make("thread-1");
const at = "2026-09-24T00:00:00.000Z";

const sent = (
  messageId: string,
  text: string,
  streaming: boolean,
  turnId = "t1",
  role: "assistant" | "user" = "assistant",
) =>
  ({
    type: "thread.message-sent",
    payload: {
      threadId: THREAD,
      messageId: MessageId.make(messageId),
      role,
      text,
      turnId: TurnId.make(turnId),
      streaming,
      createdAt: at,
      updatedAt: at,
    },
  }) as unknown as OrchestrationEvent;

const activity = (summary: string, turnId = "t1") =>
  ({
    type: "thread.activity-appended",
    payload: {
      threadId: THREAD,
      activity: {
        id: EventId.make(`a-${summary}`),
        tone: "tool",
        kind: "tool.started",
        summary,
        payload: null,
        turnId: TurnId.make(turnId),
        createdAt: at,
      },
    },
  }) as unknown as OrchestrationEvent;

const stored = (id: string, text: string, turnId = "t1"): OrchestrationMessage => ({
  id: MessageId.make(id),
  role: "assistant",
  text,
  turnId: TurnId.make(turnId),
  streaming: false,
  createdAt: at,
  updatedAt: at,
});

const textOf = (renderer: ThreadFollowRenderer, events: ReadonlyArray<OrchestrationEvent>) =>
  events
    .flatMap((event) => renderer.handleEvent(event))
    .map((output) => (output.type === "text" ? output.text : `[${output.summary}]`))
    .join("");

it("prints streaming deltas and only the unseen tail of the final message", () => {
  const renderer = new ThreadFollowRenderer();
  const out = textOf(renderer, [
    sent("m1", "Hel", true),
    sent("m1", "lo", true),
    sent("m1", "Hello world", false),
  ]);
  assert.strictEqual(out, "Hello world");
});

it("separates messages and activities, and ignores user messages", () => {
  const renderer = new ThreadFollowRenderer();
  const out = textOf(renderer, [
    sent("u1", "question", false, "t1", "user"),
    sent("m1", "Checking.", false),
    activity("Ran speedtest"),
    sent("m2", "Done.", false),
  ]);
  assert.strictEqual(out, "Checking.[Ran speedtest]\n\nDone.");
});

it("never repeats seeded messages and continues an in-progress one", () => {
  const renderer = new ThreadFollowRenderer();
  renderer.seed([stored("old", "old reply", "t0"), stored("m1", "Partial")]);
  const out = textOf(renderer, [sent("old", "old reply", false, "t0"), sent("m1", " more", true)]);
  assert.strictEqual(out, " more");
});

it("filters to the followed turn once it is known", () => {
  const renderer = new ThreadFollowRenderer();
  renderer.setTurn("t2");
  const out = textOf(renderer, [
    sent("m1", "other turn", false, "t1"),
    sent("m2", "mine", false, "t2"),
  ]);
  assert.strictEqual(out, "mine");
});

it("reconciles text the stream missed against the stored turn", () => {
  const renderer = new ThreadFollowRenderer();
  textOf(renderer, [sent("m1", "Hello", true)]);
  const missed = renderer
    .reconcile([stored("m1", "Hello world"), stored("m2", "Second"), stored("x", "no", "t9")], "t1")
    .map((output) => (output.type === "text" ? output.text : ""))
    .join("");
  assert.strictEqual(missed, " world\n\nSecond");
  assert.deepStrictEqual(renderer.reconcile([stored("m1", "Hello world")], "t1"), []);
});

it("builds the WebSocket URL from the server origin", () => {
  assert.strictEqual(
    webSocketUrlForOrigin("http://127.0.0.1:3773", "tick"),
    "ws://127.0.0.1:3773/ws?wsTicket=tick",
  );
  assert.strictEqual(
    webSocketUrlForOrigin("https://host.example/app?x=1", "t"),
    "wss://host.example/ws?wsTicket=t",
  );
});
