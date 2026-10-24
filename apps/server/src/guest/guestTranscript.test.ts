import { describe, expect, it } from "@effect/vitest";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { guestItemEvent, guestTranscriptItem } from "./guestTranscript.ts";

const base = {
  id: "item",
  threadId: "thread",
  runId: "run",
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed",
  title: "cat .env",
  startedAt: null,
  completedAt: null,
  updatedAt: DateTime.makeUnsafe(0),
};
const item = (fields: Record<string, unknown>) =>
  ({ ...base, ...fields }) as unknown as OrchestrationV2TurnItem;

describe("guestTranscriptItem", () => {
  it("shows a command as a fixed label without its title or output", () => {
    expect(
      guestTranscriptItem(
        item({ type: "command_execution", command: "cat .env", output: "TOKEN=secret" }),
      ),
    ).toEqual({ kind: "tool", id: "item", tool: "command" });
  });

  it("drops reasoning, approvals, secret requests, and unknown items", () => {
    for (const type of ["reasoning", "approval_request", "secret_request", "future_item"]) {
      expect(guestTranscriptItem(item({ type, text: "hidden" }))).toBeNull();
    }
  });

  it("drops messages a person did not type into this thread", () => {
    const message = { type: "user_message", text: "webhook body", createdBy: "user" };
    expect(guestTranscriptItem(item({ ...message, scheduledTaskId: "task" }))).toBeNull();
    expect(guestTranscriptItem(item({ ...message, senderThreadId: "other" }))).toBeNull();
    expect(guestTranscriptItem(item({ ...message, createdBy: "agent" }))).toBeNull();
    expect(guestTranscriptItem(item(message))).toEqual({
      kind: "user",
      id: "item",
      text: "webhook body",
      streaming: false,
    });
  });

  it("shows a sent guest message as the guest wrote it, without the agent's attribution", () => {
    const guest = { guestMessageId: "guest-message:one", name: "Sam", text: "Why?" };
    expect(
      guestTranscriptItem(
        item({
          type: "user_message",
          text: "Message from guest Sam, sent by the owner:\n\nWhy?",
          createdBy: "user",
          context: { version: 1, records: [], guest },
        }),
      ),
    ).toEqual({
      kind: "user",
      id: "item",
      text: "Why?",
      streaming: false,
      guestMessageId: "guest-message:one",
      guestName: "Sam",
    });
  });
});

describe("guestItemEvent", () => {
  const assistant = (text: string) =>
    ({ kind: "assistant", id: "a", text, streaming: true }) as const;

  it("sends only the new suffix while text grows", () => {
    expect(guestItemEvent("Hel", assistant("Hello"))).toEqual({
      type: "append",
      id: "a",
      text: "lo",
      streaming: true,
    });
  });

  it("replaces the item when text changes in place", () => {
    expect(guestItemEvent("Goodbye", assistant("Hello"))).toEqual({
      type: "item",
      item: assistant("Hello"),
    });
  });
});
