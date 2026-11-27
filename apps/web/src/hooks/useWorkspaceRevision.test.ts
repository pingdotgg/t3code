import { describe, expect, it } from "vite-plus/test";

import { advanceWorkspaceVisit, workspaceRevisionOf } from "./useWorkspaceRevision";

function visitThread(threadKey: string, unloaded: boolean, mutationId: string | null) {
  let visit = advanceWorkspaceVisit(null, { threadKey, unloaded, mutationId }, "view");
  return (next: { unloaded: boolean; mutationId: string | null }) => {
    visit = advanceWorkspaceVisit(visit, { threadKey, ...next }, "view");
    return workspaceRevisionOf(visit, next.mutationId);
  };
}

describe("workspace revision", () => {
  it("keeps the visit's revision for the mutation id the history loads with, not for a later one", () => {
    const render = visitThread("thread-b", true, null);
    const pending = render({ unloaded: true, mutationId: null });
    expect(pending.pending).toBe(true);
    expect(pending.revision).not.toBeNull();

    expect(render({ unloaded: false, mutationId: "b1" })).toEqual({
      revision: pending.revision,
      pending: false,
    });
    expect(render({ unloaded: false, mutationId: "b2" }).revision).toBe("b2");
    expect(render({ unloaded: false, mutationId: "b1" }).revision).toBe(pending.revision);
  });

  it("treats the first mutation of a thread whose history loaded without one as a change", () => {
    const render = visitThread("thread-b", true, null);
    const loaded = render({ unloaded: false, mutationId: null });
    expect(loaded.revision).not.toBeNull();
    expect(render({ unloaded: false, mutationId: "b1" }).revision).toBe("b1");
  });

  it("is the mutation id when the visit began with the history known", () => {
    const render = visitThread("thread-b", false, "b1");
    expect(render({ unloaded: false, mutationId: "b1" })).toEqual({
      revision: "b1",
      pending: false,
    });
  });

  it("starts over, under another revision, for another thread and for a later visit", () => {
    const input = { unloaded: true, mutationId: null };
    const first = advanceWorkspaceVisit(null, { threadKey: "thread-a", ...input }, "view");
    const second = advanceWorkspaceVisit(first, { threadKey: "thread-b", ...input }, "view");
    const again = advanceWorkspaceVisit(second, { threadKey: "thread-a", ...input }, "view");
    expect(new Set([first.revision, second.revision, again.revision]).size).toBe(3);
    expect(workspaceRevisionOf(again, null).pending).toBe(true);
  });
});
