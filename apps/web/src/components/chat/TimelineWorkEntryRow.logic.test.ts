import { describe, expect, it } from "vite-plus/test";

import { workEntryStartsExpanded } from "./TimelineWorkEntryRow.logic";
import type { TimelineWorkEntry } from "./timelineRowContext";

const entry = (fields: Partial<TimelineWorkEntry>): TimelineWorkEntry => ({
  id: "entry",
  createdAt: "2026-01-01T00:00:00.000Z",
  label: "Ran command",
  tone: "tool",
  ...fields,
});

describe("workEntryStartsExpanded", () => {
  it.each([
    ["a command with the setting off", entry({ itemType: "command_execution" }), false, false],
    ["a command with the setting on", entry({ itemType: "command_execution" }), true, true],
    [
      "a thought with text",
      entry({ itemType: "reasoning", detail: "Plan the change" }),
      true,
      true,
    ],
    ["a thought with no text yet", entry({ itemType: "reasoning", detail: "  " }), true, false],
    ["a viewed image", entry({ viewedImagePath: "/repo/screen.png" }), true, false],
    [
      "an answered question",
      entry({ questionAnswer: { answers: {}, attachmentsByQuestionId: {} } as never }),
      true,
      false,
    ],
  ])("%s", (_name, workEntry, expandedByDefault, expected) => {
    expect(workEntryStartsExpanded(workEntry, expandedByDefault)).toBe(expected);
  });
});
