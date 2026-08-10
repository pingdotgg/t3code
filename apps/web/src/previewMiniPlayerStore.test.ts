import type { ScopedThreadRef } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { usePreviewMiniPlayerStore } from "./previewMiniPlayerStore";

const first = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};
const second = { ...first, threadId: "thread-2" as ScopedThreadRef["threadId"] };

beforeEach(() => usePreviewMiniPlayerStore.setState({ byThreadKey: {} }));

describe("previewMiniPlayerStore", () => {
  it("keeps player state scoped to its thread and preserves its layout across tab changes", () => {
    const store = usePreviewMiniPlayerStore.getState();
    store.open(first, "tab-a");
    store.move(first, "tab-a", { x: 20, y: 30 });
    store.resize(first, "tab-a", { width: 360, height: 220 });
    store.open(first, "tab-b");
    store.open(second, "tab-c");

    const entries = usePreviewMiniPlayerStore.getState().byThreadKey;
    expect(Object.values(entries)).toEqual(
      expect.arrayContaining([
        { tabId: "tab-b", position: { x: 20, y: 30 }, size: { width: 360, height: 220 } },
        { tabId: "tab-c", position: null, size: null },
      ]),
    );
  });

  it("drops stale tab drag and resize events", () => {
    const store = usePreviewMiniPlayerStore.getState();
    store.open(first, "tab-current");
    store.move(first, "tab-stale", { x: 20, y: 30 });
    store.resize(first, "tab-stale", { width: 360, height: 220 });

    expect(Object.values(usePreviewMiniPlayerStore.getState().byThreadKey)).toEqual([
      { tabId: "tab-current", position: null, size: null },
    ]);
  });

  it("removes only the deleted thread's floating preview", () => {
    const store = usePreviewMiniPlayerStore.getState();
    store.open(first, "tab-a");
    store.open(second, "tab-b");
    store.removeThread(first);

    expect(Object.values(usePreviewMiniPlayerStore.getState().byThreadKey)).toEqual([
      { tabId: "tab-b", position: null, size: null },
    ]);
  });

  it("no-ops equal move and resize values", () => {
    const store = usePreviewMiniPlayerStore.getState();
    store.open(first, "tab-a");
    store.move(first, "tab-a", { x: 20, y: 30 });
    store.resize(first, "tab-a", { width: 360, height: 220 });
    const before = usePreviewMiniPlayerStore.getState().byThreadKey;

    store.move(first, "tab-a", { x: 20, y: 30 });
    store.resize(first, "tab-a", { width: 360, height: 220 });

    expect(usePreviewMiniPlayerStore.getState().byThreadKey).toBe(before);
  });
});
