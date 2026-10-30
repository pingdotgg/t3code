import { ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  getThreadKeysToDeselectAfterDelete,
  useThreadSelectionStore,
} from "./threadSelectionStore";

const THREAD_A = ThreadId.make("thread-a");
const THREAD_B = ThreadId.make("thread-b");
const THREAD_C = ThreadId.make("thread-c");
const THREAD_D = ThreadId.make("thread-d");
const THREAD_E = ThreadId.make("thread-e");

const ORDERED = [THREAD_A, THREAD_B, THREAD_C, THREAD_D, THREAD_E] as const;

describe("threadSelectionStore", () => {
  beforeEach(() => {
    useThreadSelectionStore.getState().clearSelection();
  });

  describe("bulk deletion cleanup", () => {
    it("clears missing selection rows and completed deletions while retaining a failed thread", () => {
      const store = useThreadSelectionStore.getState();
      store.toggleThread(THREAD_A);
      store.toggleThread(THREAD_B);
      store.toggleThread(THREAD_C);
      const selected = [...useThreadSelectionStore.getState().selectedThreadKeys];
      const existingThreads = new Set([THREAD_A, THREAD_B]);
      store.removeFromSelection(
        getThreadKeysToDeselectAfterDelete(selected, new Set([THREAD_A]), (key) =>
          existingThreads.has(ThreadId.make(key)),
        ),
      );

      expect([...useThreadSelectionStore.getState().selectedThreadKeys]).toEqual([THREAD_B]);
      expect(useThreadSelectionStore.getState().anchorThreadKey).toBeNull();
    });

    it("keeps unprocessed and hidden live threads and selections added while deletion was pending", () => {
      const store = useThreadSelectionStore.getState();
      store.toggleThread(THREAD_A);
      store.toggleThread(THREAD_B);
      store.toggleThread(THREAD_C);
      const selected = [...useThreadSelectionStore.getState().selectedThreadKeys];
      store.toggleThread(THREAD_D);
      store.removeFromSelection(
        getThreadKeysToDeselectAfterDelete(selected, new Set([THREAD_A]), () => true),
      );

      expect([...useThreadSelectionStore.getState().selectedThreadKeys]).toEqual([
        THREAD_B,
        THREAD_C,
        THREAD_D,
      ]);
      expect(useThreadSelectionStore.getState().anchorThreadKey).toBe(THREAD_D);
    });
  });

  describe("setAnchor", () => {
    it("enables range select from a plain-click anchor", () => {
      const store = useThreadSelectionStore.getState();
      store.setAnchor(THREAD_B);
      store.rangeSelectTo(THREAD_D, ORDERED);

      const state = useThreadSelectionStore.getState();
      expect(state.selectedThreadKeys.has(THREAD_B)).toBe(true);
      expect(state.selectedThreadKeys.has(THREAD_C)).toBe(true);
      expect(state.selectedThreadKeys.has(THREAD_D)).toBe(true);
      expect(state.selectedThreadKeys.size).toBe(3);
    });
  });

  describe("rangeSelectTo", () => {
    it("keeps anchor stable across multiple range selects", () => {
      const store = useThreadSelectionStore.getState();
      store.toggleThread(THREAD_B);
      store.rangeSelectTo(THREAD_D, ORDERED);
      store.rangeSelectTo(THREAD_E, ORDERED);

      const state = useThreadSelectionStore.getState();
      expect(state.anchorThreadKey).toBe(THREAD_B);
      expect(state.selectedThreadKeys.has(THREAD_B)).toBe(true);
      expect(state.selectedThreadKeys.has(THREAD_C)).toBe(true);
      expect(state.selectedThreadKeys.has(THREAD_D)).toBe(true);
      expect(state.selectedThreadKeys.has(THREAD_E)).toBe(true);
    });

    it("falls back to toggle when anchor is not in the ordered list", () => {
      const store = useThreadSelectionStore.getState();
      store.toggleThread(THREAD_A);
      store.rangeSelectTo(THREAD_C, [THREAD_B, THREAD_C, THREAD_D]);

      const state = useThreadSelectionStore.getState();
      expect(state.selectedThreadKeys.has(THREAD_C)).toBe(true);
      expect(state.anchorThreadKey).toBe(THREAD_C);
    });

    it("preserves previously selected threads outside the range", () => {
      const store = useThreadSelectionStore.getState();
      store.toggleThread(THREAD_A);
      store.toggleThread(THREAD_B);

      store.rangeSelectTo(THREAD_D, ORDERED);

      const state = useThreadSelectionStore.getState();
      expect(state.selectedThreadKeys.has(THREAD_A)).toBe(true);
      expect(state.selectedThreadKeys.has(THREAD_B)).toBe(true);
      expect(state.selectedThreadKeys.has(THREAD_C)).toBe(true);
      expect(state.selectedThreadKeys.has(THREAD_D)).toBe(true);
      expect(state.selectedThreadKeys.size).toBe(4);
    });
  });
});
