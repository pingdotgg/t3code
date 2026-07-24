import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { assistantMessageTurnChanged, mergeThreadMessageProjection } from "./threadMessageProjection.ts";

describe("threadMessageProjection", () => {
  it("detects turn changes on reused assistant message ids", () => {
    expect(
      assistantMessageTurnChanged(
        { text: "old", turnId: TurnId.make("turn-1"), createdAt: "2026-07-01T21:00:00.000Z" },
        TurnId.make("turn-2"),
      ),
    ).toBe(true);
  });

  it("resets text and createdAt when a reused message id starts a new turn", () => {
    const merged = mergeThreadMessageProjection(
      {
        text: "first turn reply",
        turnId: TurnId.make("turn-1"),
        createdAt: "2026-07-01T21:00:00.000Z",
      },
      {
        text: "second turn reply",
        turnId: TurnId.make("turn-2"),
        streaming: false,
        createdAt: "2026-07-02T01:44:30.000Z",
        updatedAt: "2026-07-02T01:44:30.000Z",
      },
    );

    expect(merged.text).toBe("second turn reply");
    expect(merged.createdAt).toBe("2026-07-02T01:44:30.000Z");
    expect(merged.turnId).toBe(TurnId.make("turn-2"));
  });

  it("appends streaming deltas within the same turn", () => {
    const merged = mergeThreadMessageProjection(
      {
        text: "hello",
        turnId: TurnId.make("turn-1"),
        createdAt: "2026-07-01T21:00:00.000Z",
      },
      {
        text: " world",
        turnId: TurnId.make("turn-1"),
        streaming: true,
        createdAt: "2026-07-01T21:00:01.000Z",
        updatedAt: "2026-07-01T21:00:01.000Z",
      },
    );

    expect(merged.text).toBe("hello world");
    expect(merged.createdAt).toBe("2026-07-01T21:00:00.000Z");
  });

  it("persists first attachments-only messages with empty text", () => {
    const merged = mergeThreadMessageProjection(undefined, {
      text: "",
      turnId: TurnId.make("turn-1"),
      streaming: false,
      createdAt: "2026-07-02T01:44:30.000Z",
      updatedAt: "2026-07-02T01:44:30.000Z",
    });

    expect(merged.text).toBe("");
    expect(merged.createdAt).toBe("2026-07-02T01:44:30.000Z");
    expect(merged.turnId).toBe(TurnId.make("turn-1"));
  });

  it("starts fresh streaming text when the turn changes", () => {
    const merged = mergeThreadMessageProjection(
      {
        text: "first turn reply",
        turnId: TurnId.make("turn-1"),
        createdAt: "2026-07-01T21:00:00.000Z",
      },
      {
        text: "Checking",
        turnId: TurnId.make("turn-2"),
        streaming: true,
        createdAt: "2026-07-02T01:44:30.000Z",
        updatedAt: "2026-07-02T01:44:30.000Z",
      },
    );

    expect(merged.text).toBe("Checking");
    expect(merged.createdAt).toBe("2026-07-02T01:44:30.000Z");
  });
});
