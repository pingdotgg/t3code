import { expect, it } from "@effect/vitest";
import { EventId, ThreadId, TurnId } from "@t3tools/contracts";

import { mapOmpSessionUpdate, ompModelsFromConfig, ompPermissionOptionId } from "../Layers/OmpAdapter.ts";

it("maps omp ACP assistant chunks to canonical content events", () => {
  const event = mapOmpSessionUpdate({
    threadId: ThreadId.make("thread-omp"),
    turnId: TurnId.make("turn-omp"),
    eventId: EventId.make("event-omp"),
    createdAt: "2026-09-19T00:00:00.000Z",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello from omp" },
    },
  });

  expect(event).toMatchObject({
    type: "content.delta",
    provider: "omp",
    payload: { streamKind: "assistant_text", delta: "hello from omp" },
  });
});

it("maps omp ACP tool calls to canonical item events", () => {
  const event = mapOmpSessionUpdate({
    threadId: ThreadId.make("thread-omp"),
    eventId: EventId.make("event-omp"),
    createdAt: "2026-09-19T00:00:00.000Z",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      title: "Run command",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "pwd" },
    },
  });

  expect(event).toMatchObject({
    type: "item.updated",
    provider: "omp",
    itemId: "call-1",
  });
});

it("keeps unrelated ACP updates out of the canonical stream", () => {
  const event = mapOmpSessionUpdate({
    threadId: ThreadId.make("thread-omp"),
    eventId: EventId.make("event-omp"),
    createdAt: "2026-09-19T00:00:00.000Z",
    update: { sessionUpdate: "current_mode_update" } as never,
  });

  expect(event).toBeUndefined();
});

it("translates ACP approval decisions and the omp model catalog", () => {
  expect(ompPermissionOptionId([
    { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
    { optionId: "reject_once", name: "Reject once", kind: "reject_once" },
  ], "accept")).toBe("allow_once");
  expect(ompPermissionOptionId([{ optionId: "reject_once", name: "Reject once", kind: "reject_once" }], "cancel"))
    .toBeUndefined();
  expect(ompModelsFromConfig([{
    id: "model", name: "Model", category: "model", type: "select", currentValue: "omp/a",
    options: [{ value: "omp/a", name: "OMP A" }, { value: "omp/b", name: "OMP B" }],
  }])).toEqual([
    { slug: "omp/a", name: "OMP A" },
    { slug: "omp/b", name: "OMP B" },
  ]);
});
