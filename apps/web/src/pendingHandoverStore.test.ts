import { describe, expect, it } from "vite-plus/test";

import type { DraftId } from "./composerDraftStore";
import { createPendingHandoverStore } from "./pendingHandoverStore";

describe("createPendingHandoverStore", () => {
  it("notifies a remounted subscriber when an existing generation completes", () => {
    const store = createPendingHandoverStore();
    let oldNotifications = 0;
    const unsubscribe = store.subscribe(() => {
      oldNotifications += 1;
    });
    store.setGenerating("source", true);
    unsubscribe();
    let observedGenerating = store.isGenerating("source");
    let observedHandover = store.get("source");
    store.subscribe(() => {
      observedGenerating = store.isGenerating("source");
      observedHandover = store.get("source");
    });
    const previousVersion = store.getVersion();
    store.save("source", { handover: "Saved continuation" });
    store.setGenerating("source", false);
    expect(observedGenerating).toBe(false);
    expect(observedHandover).toEqual({ handover: "Saved continuation" });
    expect(store.getVersion()).toBeGreaterThan(previousVersion);
    expect(oldNotifications).toBe(1);
    store.delete("source");
    expect(observedHandover).toBeUndefined();
  });
  it("keeps a generated handover recoverable by source thread", () => {
    const store = createPendingHandoverStore();
    store.save("environment:source", { handover: "handover" });

    expect(store.get("environment:source")).toEqual({ handover: "handover" });
    expect(store.get("environment:other")).toBeUndefined();
  });

  it("evicts the oldest abandoned handover", () => {
    const store = createPendingHandoverStore(2);
    store.save("thread:one", { handover: "one" });
    store.save("thread:two", { handover: "two" });
    store.save("thread:three", { handover: "three" });

    expect(store.get("thread:one")).toBeUndefined();
    expect(store.get("thread:two")).toEqual({ handover: "two" });
    expect(store.get("thread:three")).toEqual({ handover: "three" });
    expect(store.size()).toBe(2);
  });

  it("refreshes an existing entry before eviction", () => {
    const store = createPendingHandoverStore(2);
    store.save("thread:one", { handover: "one" });
    store.save("thread:two", { handover: "two" });
    store.save("thread:one", {
      handover: "one updated",
      draftId: "draft-one" as DraftId,
    });
    store.save("thread:three", { handover: "three" });

    expect(store.get("thread:one")).toEqual({
      handover: "one updated",
      draftId: "draft-one",
    });
    expect(store.get("thread:two")).toBeUndefined();
  });
});
