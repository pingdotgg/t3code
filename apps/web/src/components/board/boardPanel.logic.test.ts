import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boardVisitKey,
  presentBoardTopic,
  resolveBoardLeadShell,
  threadHasBoard,
} from "./boardPanel.logic";

const env = EnvironmentId.make("env-a");
const earlier = "2026-11-18T10:00:00.000Z";
const later = "2026-11-18T10:05:00.000Z";

function shell(id: string, groupParentThreadId?: string) {
  return {
    environmentId: env,
    id: ThreadId.make(id),
    createdAt: earlier,
    ...(groupParentThreadId ? { groupParentThreadId: ThreadId.make(groupParentThreadId) } : {}),
  };
}

const topic = (overrides: Partial<Parameters<typeof presentBoardTopic>[0]> = {}) => ({
  editCount: 0,
  updatedAt: later,
  authorInGroup: true,
  ...overrides,
});

describe("presentBoardTopic", () => {
  it.each([
    [0, null],
    [1, "edited 1 time"],
    [3, "edited 3 times"],
  ])("edit count %i reads %s", (editCount, label) => {
    expect(presentBoardTopic(topic({ editCount }), null).editedLabel).toBe(label);
  });

  it.each([
    ["never viewed", null, true],
    ["edited after the watermark", earlier, true],
    ["edited at the watermark", later, false],
    ["edited before the watermark", "2026-11-18T10:10:00.000Z", false],
  ])("updated badge: %s", (_, viewedAt, updated) => {
    expect(presentBoardTopic(topic(), viewedAt).updated).toBe(updated);
  });

  it("flags a topic whose author left the group", () => {
    expect(presentBoardTopic(topic({ authorInGroup: false }), later).authorLeft).toBe(true);
    expect(presentBoardTopic(topic(), later).authorLeft).toBe(false);
  });
});

describe("board lead", () => {
  const shells = [shell("lead"), shell("worker", "lead"), shell("solo")];

  it("resolves the lead shell from the lead, a worker, and nothing for an ungrouped thread", () => {
    expect(resolveBoardLeadShell(shells, env, ThreadId.make("worker"))?.id).toBe("lead");
    expect(resolveBoardLeadShell(shells, env, ThreadId.make("lead"))?.id).toBe("lead");
    expect(resolveBoardLeadShell(shells, env, ThreadId.make("solo"))).toBeNull();
    expect(threadHasBoard(shells, env, ThreadId.make("worker"))).toBe(true);
    expect(threadHasBoard(shells, env, ThreadId.make("solo"))).toBe(false);
  });
});

describe("boardVisitKey", () => {
  it("changes for a new or edited topic", () => {
    const base = boardVisitKey([{ updatedAt: earlier }]);
    expect(boardVisitKey([{ updatedAt: earlier }])).toBe(base);
    expect(boardVisitKey([{ updatedAt: earlier }, { updatedAt: earlier }])).not.toBe(base);
    expect(boardVisitKey([{ updatedAt: later }])).not.toBe(base);
  });
});
