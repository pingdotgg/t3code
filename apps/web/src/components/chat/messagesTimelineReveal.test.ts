import { describe, expect, it } from "vite-plus/test";
import { locateRowForEntry, findTurnIdForEntry } from "./messagesTimelineReveal";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import type { TimelineEntry, WorkLogEntry } from "../../session-logic";

const workEntry = (id: string): WorkLogEntry => ({
  id,
  createdAt: "2026-01-01T00:00:00.000Z",
  label: id,
  tone: "tool",
});

const rows: MessagesTimelineRow[] = [
  {
    kind: "message",
    id: "m1",
    createdAt: "t",
    message: {
      id: "m1",
      role: "assistant",
      text: "x",
      turnId: null,
      streaming: false,
      createdAt: "t",
      updatedAt: "t",
    },
    durationStart: "t",
    showAssistantMeta: false,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
  },
  {
    kind: "work",
    id: "w1",
    createdAt: "t",
    groupedEntries: [workEntry("w1"), workEntry("w2"), workEntry("w3")],
  },
] as unknown as MessagesTimelineRow[];

describe("locateRowForEntry", () => {
  it("finds a message row by id", () => {
    expect(locateRowForEntry(rows, "m1", "message")).toBe(0);
  });

  it("finds the work ROW for a non-first grouped entry", () => {
    expect(locateRowForEntry(rows, "w3", "work")).toBe(1);
  });

  it("returns null when not present (folded)", () => {
    expect(locateRowForEntry(rows, "missing", "message")).toBeNull();
  });
});

describe("findTurnIdForEntry", () => {
  const entries: TimelineEntry[] = [
    {
      id: "m1",
      kind: "message",
      createdAt: "t",
      message: {
        id: "m1",
        role: "assistant",
        text: "x",
        turnId: "turn-7",
        streaming: false,
        createdAt: "t",
        updatedAt: "t",
      },
    },
  ] as unknown as TimelineEntry[];

  it("returns the entry's turnId", () => {
    expect(findTurnIdForEntry(entries, "m1")).toBe("turn-7");
  });

  it("returns null for an unknown entry", () => {
    expect(findTurnIdForEntry(entries, "nope")).toBeNull();
  });
});
