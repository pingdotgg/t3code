import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  migratePersistedRightPanelState,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";

const ref = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-split"));
const key = scopedThreadKey(ref);

beforeEach(() => {
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
});

const thread = () => selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);

/** Left pane a.ts, right pane b.ts (focused). */
function splitAB() {
  const store = useRightPanelStore.getState();
  store.openFile(ref, "a.ts");
  store.openFile(ref, "b.ts");
  store.updateSplit(ref, { type: "split", surfaceId: "file:b.ts", side: "right" });
}

describe("right panel split in the store", () => {
  it("lands an upstream open in the focused right pane", () => {
    splitAB();
    useRightPanelStore.getState().openFile(ref, "c.ts");
    expect(thread().split?.rightIds).toEqual(["file:b.ts", "file:c.ts"]);
    expect(thread().activeSurfaceId).toBe("file:c.ts");
    expect(thread().split?.otherShownId).toBe("file:a.ts");
  });

  it("bumps the user revision for a move, not for a reorder, a focus or a ratio", () => {
    splitAB();
    const store = useRightPanelStore.getState();
    store.openFile(ref, "c.ts");
    const revision = () => useRightPanelStore.getState().getUserActionRevision(ref);
    const before = revision();
    store.updateSplit(ref, { type: "reorder", surfaceId: "file:c.ts", beforeId: "file:b.ts" });
    store.updateSplit(ref, { type: "focus", pane: "left" });
    store.updateSplit(ref, { type: "ratio", ratio: 0.3 });
    expect(revision()).toBe(before);
    expect(thread().split).toEqual({
      rightIds: ["file:c.ts", "file:b.ts"],
      otherShownId: "file:c.ts",
      ratio: 0.3,
    });
    store.updateSplit(ref, { type: "move", surfaceId: "file:b.ts", pane: "left", beforeId: null });
    expect(revision()).toBe(before + 1);
    expect(thread().split?.rightIds).toEqual(["file:c.ts"]);
  });

  it("refuses a proactive diff that the unfocused pane already shows", () => {
    const store = useRightPanelStore.getState();
    store.open(ref, "diff");
    store.openFile(ref, "a.ts");
    store.updateSplit(ref, { type: "split", surfaceId: "diff", side: "right" });
    store.updateSplit(ref, { type: "focus", pane: "left" });
    const revision = store.getUserActionRevision(ref);
    expect(store.openProactive(ref, { kind: "diff", turnId: RunId.make("turn-1") }, revision)).toBe(
      false,
    );
    expect(thread().activeSurfaceId).toBe("file:a.ts");
  });

  it("migrates a v14 record without a split and keeps a v15 split", () => {
    const record = {
      isOpen: true,
      activeSurfaceId: "file:b.ts",
      surfaces: [
        {
          id: "file:a.ts",
          kind: "file",
          relativePath: "a.ts",
          revealLine: null,
          revealRequestId: 1,
        },
        {
          id: "file:b.ts",
          kind: "file",
          relativePath: "b.ts",
          revealLine: null,
          revealRequestId: 1,
        },
      ],
    };
    const split = { rightIds: ["file:b.ts"], otherShownId: "file:a.ts", ratio: 0.4 };
    expect(
      migratePersistedRightPanelState({ byThreadKey: { [key]: record } }).byThreadKey[key]?.split,
    ).toBeUndefined();
    expect(
      migratePersistedRightPanelState({ byThreadKey: { [key]: { ...record, split } } }).byThreadKey[
        key
      ]?.split,
    ).toEqual(split);
  });

  it("round-trips a split through storage and repairs a same-version record", async () => {
    splitAB();
    useRightPanelStore.getState().updateSplit(ref, { type: "ratio", ratio: 0.6 });
    const saved = thread().split;
    const { storage, name } = useRightPanelStore.persist.getOptions();
    const persisted = (await storage!.getItem(name!))!;
    expect(persisted.version).toBe(15);
    // Resetting the store writes it to storage, so the saved value goes back before rehydrating.
    const reload = async (value: typeof persisted) => {
      useRightPanelStore.setState(useRightPanelStore.getInitialState());
      await storage!.setItem(name!, value);
      await useRightPanelStore.persist.rehydrate();
    };

    await reload(persisted);
    expect(thread().split).toEqual(saved);

    const corrupt = structuredClone(persisted);
    const state = corrupt.state as { byThreadKey: Record<string, { split: unknown }> };
    state.byThreadKey[key]!.split = {
      rightIds: ["file:gone", "file:b.ts"],
      otherShownId: "file:b.ts",
      ratio: 9,
    };
    await reload(corrupt);
    expect(thread().split).toEqual({
      rightIds: ["file:b.ts"],
      otherShownId: "file:a.ts",
      ratio: 0.8,
    });
  });
});
