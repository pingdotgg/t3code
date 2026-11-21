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
  it("keeps the placeholder for the mutation id the history loads with, not for a later one", () => {
    const render = visitThread("thread-b", true, null);
    const pending = render({ unloaded: true, mutationId: null });
    expect(pending.pending).toBe(true);
    expect(pending.placeholder).toBeDefined();

    expect(render({ unloaded: false, mutationId: "b1" })).toEqual({
      pending: false,
      placeholder: pending.placeholder,
    });
    expect(render({ unloaded: false, mutationId: "b2" })).toEqual({
      pending: false,
      placeholder: undefined,
    });
    expect(render({ unloaded: false, mutationId: "b1" }).placeholder).toBe(pending.placeholder);
  });

  it("treats the first mutation of a thread whose history loaded without one as a change", () => {
    const render = visitThread("thread-b", true, null);
    expect(render({ unloaded: false, mutationId: null }).placeholder).toBeDefined();
    expect(render({ unloaded: false, mutationId: "b1" }).placeholder).toBeUndefined();
  });

  it("has no placeholder when the visit began with the history known", () => {
    const render = visitThread("thread-b", false, "b1");
    expect(render({ unloaded: false, mutationId: "b1" })).toEqual({
      pending: false,
      placeholder: undefined,
    });
  });

  it("starts over, under another placeholder, for another thread", () => {
    const first = advanceWorkspaceVisit(
      null,
      { threadKey: "thread-a", unloaded: true, mutationId: null },
      "view",
    );
    const second = advanceWorkspaceVisit(
      first,
      { threadKey: "thread-b", unloaded: true, mutationId: null },
      "view",
    );
    expect(second.placeholder).not.toBe(first.placeholder);
    expect(workspaceRevisionOf(second, null).pending).toBe(true);
  });
});
