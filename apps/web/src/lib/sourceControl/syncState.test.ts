import { describe, expect, it } from "vite-plus/test";
import { deriveSyncState, trackingHint } from "./syncState";
import type { WorkingCopyStatus } from "./types";

/**
 * The header's ONE sync button. Five permanently-visible affordances collapsed
 * into one label derived from state, so this derivation is the whole contract.
 */

const status = (over: Partial<WorkingCopyStatus> = {}): WorkingCopyStatus => ({
  isRepo: true,
  refName: "main",
  files: [],
  ahead: 0,
  behind: 0,
  hasUpstream: true,
  detached: false,
  operationInProgress: null,
  ...over,
});

describe("deriveSyncState", () => {
  it("clean and tracking → Refresh, unemphasized", () => {
    const state = deriveSyncState(status());
    expect(state.kind).toBe("fetch");
    // fork: f4 F-02 — the rung re-reads status behind a server-side TTL; it
    // does not run `git fetch`, so it must not claim to.
    expect(state.label).toBe("Refresh");
    expect(state.title).not.toContain("Fetch from remote");
    expect(state.emphasis).toBe(false);
  });

  it("no upstream → Publish", () => {
    const state = deriveSyncState(status({ hasUpstream: false, ahead: 3 }));
    expect(state.kind).toBe("publish");
    expect(state.label).toBe("Publish");
    expect(state.emphasis).toBe(true);
    expect(state.title).toContain('"main"');
  });

  it("an unpublished branch with NO commits still offers Publish", () => {
    expect(deriveSyncState(status({ hasUpstream: false, ahead: 0 })).kind).toBe("publish");
  });

  it("names the branch defensively when the ref is unknown", () => {
    expect(deriveSyncState(status({ hasUpstream: false, refName: null })).title).toContain(
      "this branch",
    );
  });

  it("ahead only → Push <n>", () => {
    const state = deriveSyncState(status({ ahead: 2 }));
    expect(state.kind).toBe("push");
    expect(state.label).toBe("Push 2");
    expect(state.title).toBe("Push 2 commits to the remote");
  });

  it("behind only → Pull <n>", () => {
    const state = deriveSyncState(status({ behind: 3 }));
    expect(state.kind).toBe("pull");
    expect(state.label).toBe("Pull 3");
  });

  it("singular commit counts read as singular", () => {
    expect(deriveSyncState(status({ ahead: 1 })).title).toBe("Push 1 commit to the remote");
    expect(deriveSyncState(status({ behind: 1 })).title).toBe("Pull 1 commit from the remote");
  });

  it("diverged → Sync ↑a↓b, and never a bare Push", () => {
    const state = deriveSyncState(status({ ahead: 2, behind: 1 }));
    expect(state.kind).toBe("sync");
    expect(state.label).toBe("Sync ↑2↓1");
    expect(state.emphasis).toBe(true);
  });

  it("publish outranks diverged — you cannot pull without an upstream", () => {
    expect(deriveSyncState(status({ hasUpstream: false, ahead: 2, behind: 1 })).kind).toBe(
      "publish",
    );
  });

  it("detached HEAD → Fetch, the only remote verb that still means anything", () => {
    for (const over of [{ ahead: 4 }, { behind: 4 }, { hasUpstream: false }]) {
      expect(deriveSyncState(status({ detached: true, ...over })).kind).toBe("fetch");
    }
  });

  it("no status at all → Fetch, never a crash", () => {
    expect(deriveSyncState(null).kind).toBe("fetch");
    expect(deriveSyncState(undefined).kind).toBe("fetch");
  });

  it("treats absent ahead/behind counts ([gone] upstream) as zero", () => {
    const state = deriveSyncState(status({ ahead: undefined, behind: undefined }));
    expect(state.kind).toBe("fetch");
    expect([state.ahead, state.behind]).toEqual([0, 0]);
  });

  it("carries ahead/behind through so the caller need not re-read them", () => {
    const state = deriveSyncState(status({ ahead: 7, behind: 2 }));
    expect([state.ahead, state.behind]).toEqual([7, 2]);
  });

  it("returns exactly one action — the kinds are mutually exclusive", () => {
    const kinds = new Set(
      [
        status(),
        status({ ahead: 1 }),
        status({ behind: 1 }),
        status({ ahead: 1, behind: 1 }),
        status({ hasUpstream: false }),
        status({ detached: true }),
      ].map((value) => deriveSyncState(value).kind),
    );
    expect(kinds).toEqual(new Set(["fetch", "push", "pull", "sync", "publish"]));
  });
});

describe("trackingHint", () => {
  it("is empty when in step", () => {
    expect(trackingHint(status(), { kind: "fetch" })).toBe("");
  });

  it("shows only the non-zero side", () => {
    expect(trackingHint(status({ ahead: 2 }), { kind: "fetch" })).toBe("↑2");
    expect(trackingHint(status({ behind: 5 }), { kind: "fetch" })).toBe("↓5");
  });

  const hintFor = (over: Partial<WorkingCopyStatus>) => {
    const value = status(over);
    return trackingHint(value, deriveSyncState(value));
  };

  it("drops the ahead count Push already states", () => {
    expect(hintFor({ ahead: 26 })).toBe("");
  });

  it("drops the behind count Pull already states", () => {
    expect(hintFor({ behind: 3 })).toBe("");
  });

  it("drops both when Sync states both", () => {
    expect(hintFor({ ahead: 2, behind: 1 })).toBe("");
  });

  it("keeps a count the sync button is NOT stating", () => {
    expect(hintFor({ hasUpstream: false, ahead: 4 })).toBe("↑4");
    expect(trackingHint(status({ ahead: 2, behind: 1 }), { kind: "fetch" })).toBe("↑2 ↓1");
    expect(trackingHint(status({ ahead: 2, behind: 1 }), { kind: "pull" })).toBe("↑2");
    expect(trackingHint(status({ ahead: 2, behind: 1 }), { kind: "push" })).toBe("↓1");
  });

  it("is empty on a detached HEAD — there is no upstream to be ahead of", () => {
    expect(hintFor({ detached: true, ahead: 2 })).toBe("");
  });

  it("never crashes without a status", () => {
    expect(trackingHint(null, { kind: "fetch" })).toBe("");
    expect(trackingHint(undefined, { kind: "push" })).toBe("");
  });
});
