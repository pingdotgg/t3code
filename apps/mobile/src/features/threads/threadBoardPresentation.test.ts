import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { presentBoardTopic, resolveBoardLeadShell } from "./threadBoardPresentation";

const environmentId = EnvironmentId.make("env-1");
const shell = (id: string, groupParentThreadId: string | null = null) => ({
  environmentId,
  id: ThreadId.make(id),
  groupParentThreadId: groupParentThreadId === null ? null : ThreadId.make(groupParentThreadId),
  createdAt: "2026-01-01T00:00:00.000Z",
});

const topic = (overrides: Partial<Parameters<typeof presentBoardTopic>[0]> = {}) => ({
  editCount: 0,
  updatedAt: "2026-06-01T00:00:00.000Z",
  authorInGroup: true,
  ...overrides,
});

describe("presentBoardTopic", () => {
  it.each([
    [0, null],
    [1, "edited 1 time"],
    [3, "edited 3 times"],
  ])("labels %i edits", (editCount, editedLabel) => {
    expect(presentBoardTopic(topic({ editCount }), null).editedLabel).toBe(editedLabel);
  });

  it.each([
    ["no watermark", null, true],
    ["equal timestamp", "2026-06-01T00:00:00.000Z", false],
    ["later edit", "2026-05-31T00:00:00.000Z", true],
  ])("updated with %s", (_name, viewedAt, updated) => {
    expect(presentBoardTopic(topic(), viewedAt).updated).toBe(updated);
  });

  it("flags a topic whose author left the group", () => {
    expect(presentBoardTopic(topic({ authorInGroup: false }), null).authorLeft).toBe(true);
    expect(presentBoardTopic(topic(), null).authorLeft).toBe(false);
  });
});

describe("resolveBoardLeadShell", () => {
  const shells = [shell("lead"), shell("worker", "lead"), shell("solo")];

  it("returns the lead for the lead and for a worker", () => {
    expect(resolveBoardLeadShell(shells, environmentId, ThreadId.make("lead"))?.id).toBe("lead");
    expect(resolveBoardLeadShell(shells, environmentId, ThreadId.make("worker"))?.id).toBe("lead");
  });

  it("returns null for an ungrouped thread", () => {
    expect(resolveBoardLeadShell(shells, environmentId, ThreadId.make("solo"))).toBeNull();
  });
});
