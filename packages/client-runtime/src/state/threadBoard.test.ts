import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scopedThreadKey, scopeThreadRef } from "../environment/scoped.ts";
import {
  boardHasUpdates,
  type BoardLeadShell,
  resolveBoardLeadKey,
  topicUpdatedSince,
} from "./threadBoard.ts";
import type { ThreadGroupCandidate } from "./threadGroups.ts";

const env = EnvironmentId.make("env-a");
const earlier = "2026-11-18T10:00:00.000Z";
const later = "2026-11-18T10:05:00.000Z";

function thread(id: string, groupParentThreadId?: string): ThreadGroupCandidate {
  return {
    environmentId: env,
    id: ThreadId.make(id),
    createdAt: earlier,
    ...(groupParentThreadId ? { groupParentThreadId: ThreadId.make(groupParentThreadId) } : {}),
  };
}

describe("threadBoard", () => {
  it.each<[string, BoardLeadShell, boolean]>([
    ["no board fields", {}, false],
    ["never viewed, no topics", { boardUpdatedAt: later, boardViewedAt: null }, false],
    ["never viewed, with topics", { boardTopicCount: 2, boardUpdatedAt: later }, true],
    ["no updates yet", { boardTopicCount: 0, boardUpdatedAt: null, boardViewedAt: later }, false],
    ["viewed at the last update", { boardUpdatedAt: later, boardViewedAt: later }, false],
    ["viewed after the last update", { boardUpdatedAt: earlier, boardViewedAt: later }, false],
    ["updated after the last view", { boardUpdatedAt: later, boardViewedAt: earlier }, true],
  ])("boardHasUpdates: %s", (_, shell, expected) => {
    expect(boardHasUpdates(shell)).toBe(expected);
  });

  it.each<[string, string | null, boolean]>([
    ["null watermark", null, true],
    ["equal timestamps", later, false],
    ["later edit", earlier, true],
  ])("topicUpdatedSince: %s", (_, viewedAt, expected) => {
    expect(topicUpdatedSince({ updatedAt: later }, viewedAt)).toBe(expected);
  });

  it("resolves the board lead for a lead, a worker and an ungrouped thread", () => {
    const shells = [thread("lead"), thread("worker", "lead"), thread("solo")];
    const leadKey = scopedThreadKey(scopeThreadRef(env, ThreadId.make("lead")));
    expect(resolveBoardLeadKey(shells, env, ThreadId.make("lead"))).toBe(leadKey);
    expect(resolveBoardLeadKey(shells, env, ThreadId.make("worker"))).toBe(leadKey);
    expect(resolveBoardLeadKey(shells, env, ThreadId.make("solo"))).toBeNull();
  });
});
