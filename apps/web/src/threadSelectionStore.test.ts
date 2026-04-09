import { ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { useThreadSelectionStore } from "./threadSelectionStore";

const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");
const THREAD_C = ThreadId.makeUnsafe("thread-c");
const THREAD_D = ThreadId.makeUnsafe("thread-d");
const THREAD_E = ThreadId.makeUnsafe("thread-e");

const ORDERED = [THREAD_A, THREAD_B, THREAD_C, THREAD_D, THREAD_E] as const;

describe("threadSelectionStore", () => {
  beforeEach(() => {
    useThreadSelectionStore.getState().clearSelection();
  });

  describe("toggleThread", () => {
    it("adds a thread to empty selection", () => {
      useThreadSelectionStore.getState().toggleThread(THREAD_A);

      const state = useThreadSelectionStore.getState();
      expect(state.selectedThreadKeys.has(THREAD_A)).toBe(true);
      expect(state.selectedThreadKeys.size).toBe(1);
      expect(state.anchorThreadKey).toBe(THREAD_A);
    });

    it("removes a thread that is already selected", () => {
      const store = useThreadSelectionStore.getState();
      store.toggleThread(THREAD_A);
      store.toggleThread(THREAD_A);

      const state = useThreadSelectionStore.getState();
      expect(state.selectedThreadKeys.has(THREAD_A)).toBe(false);
      expect(state.selectedThreadKeys.size).toBe(0);
    });

    it("preserves existing selections when toggling a new thread", () => {
      const store = useThreadSelectionStore.getState();
      store.toggleThread(THREAD_A);
      store.toggleThread(THREAD_B);

      const state = useThreadSelectionStore.getState();
      expect(state.selectedThreadKeys.has(THREAD_A)).toBe(true);
      expect(state.selectedThreadKeys.has(THREAD_B)).toBe(true);
      expect(state.selectedThreadKeys.size).toBe(2);
    });

    it("sets anchor to the newly added thread", () => {
      const store = useThreadSelectionStore.getState();
      store.toggleThread(THREAD_A);
      store.toggleThread(THREAD_B);

      expect(useThreadSelectionStore.getState().anchorThreadKey).toBe(THREAD_B);
    });

    it("preserves anchor when deselecting a non-anchor thread", () => {
      const store = useThreadSelectionStore.getState();
      store.toggleThread(THREAD_A);
      store.toggleThread(THREAD_B);
      store.toggleThread(THREAD_A); // deselect A, anchor should stay B

      expect(useThreadSelectionStore.getState().anchorThreadKey).toBe(THREAD_B);
    });
  });

  describe("setAnchor", () => {
    it("sets anchor without adding to selection", () => {
      useThreadSelectionStore.getState().setAnchor(THREAD_B);

      const state = useThreadSelectionStore.getState();
      expect(state.anchorThreadKey).toBe(THREAD_B);
      expect(state.selectedThreadKeys.size).toBe(0);
    });

    it("enables range select from a plain-click anchor", () => {
      const store = useThreadSelectionStore.getState();
      store.setAnchor(THREAD_B); // simulate plain-click navigate to B
      store.rangeSelectTo(THREAD_D, ORDERED); // shift-click D

      const state = useThreadSelectionStore.getState();
      expect(state.selectedThreadKeys.has(THREAD_B)).toBe(true);
      expect(state.selectedThreadKeys.has(THREAD_C)).toBe(true);
      expect(state.selectedThreadKeys.has(THREAD_D)).toBe(true);
      expect(state.selectedThreadKeys.size).toBe(3);
    });

    it("is a no-op when anchor is already set to the same thread", () => {
      const store = useThreadSelectionStore.getState();
      store.setAnchor(THREAD_B);
      const stateBefore = useThreadSelectionStore.getState();
      store.setAnchor(THREAD_B);
      const stateAfter = useThreadSelectionStore.getState();

      // Should be referentially the same (no unnecessary re-render)
      expect(stateAfter).toBe(stateBefore);
    });

    it("survives clearSelection followed by setAnchor", () => {
      const store = useThreadSelectionStore.getState();
      store.toggleThread(THREAD_A);
      store.toggleThread(THREAD_B);
      store.clearSelection();
      store.setAnchor(THREAD_C);

      const state = useThreadSelectionStore.getState();
      expect(state.anchorThreadKey).toBe(THREAD_C);
      expect(state.selectedThreadKeys.size).toBe(0);
    });
  });

  describe("rangeSelectTo", () => {
    it("selects a single thread when no anchor exists", () => {
      useThreadSelectionStore.getState().rangeSelectTo(THREAD_C, ORDERED);

      const state = useThreadSelectionStore.getState();
      expect(state.selectedThreadKeys.has(THREAD_C)).toBe(true);
      expect(state.selectedThreadKeys.size).toBe(1);
      expect(state.anchorThreadKey).toBe(THREAD_C);
    });

    it("selects range from anchor to target (forward)", () => {
      const store = useThreadSelectionStore.getState();
      store.toggleThread(THREAD_B); // sets anchor to B
      store.rangeSelectTo(THREAD_D, ORDERED);

      const state = useThreadSelectionStore.getState();
      expect(state.selectedThreadKeys.has(THREAD_B)).toBe(true);
      expect(state.selectedThreadKeys.has(THREAD_C)).toBe(true);
      expect(state.selectedThreadKeys.has(THREAD_D)).toBe(true);
      expect(state.selectedThreadKeys.size).toBe(3);
    });

    it("selects range from anchor to target (backward)", () => {
      const store = useThreadSelectionStore.getState();
      store.toggleThread(THREAD_D); // sets anchor to D
      store.rangeSelectTo(THREAD_B, ORDERED);

      const state = useThreadSelectionStore.getState();
      expect(state.selectedThreadKeys.has(THREAD_B)).toBe(true);
      expect(state.selectedThreadKeys.has(THREAD_C)).toBe(true);
      expect(state.selectedThreadKeys.has(THREAD_D)).toBe(true);
      expect(state.selectedThreadKeys.size).toBe(3);
    });

    it("keeps anchor stable across multiple range selects", () => {
      const store = useThreadSelectionStore.getState();
      store.toggleThread(THREAD_B); // anchor = B
      store.rangeSelectTo(THREAD_D, ORDERED); // selects B-D
      store.rangeSelectTo(THREAD_E, ORDERED); // extends B-E (anchor stays B)

      const state = useThreadSelectionStore.getState();
      expect(state.anchorThreadKey).toBe(THREAD_B);
      expect(state.selectedThreadKeys.has(THREAD_B)).toBe(true);
      expect(state.selectedThreadKeys.has(THREAD_C)).toBe(true);
      expect(state.selectedThreadKeys.has(THREAD_D)).toBe(true);
      expect(state.selectedThreadKeys.has(THREAD_E)).toBe(true);
    });

    it("falls back to toggle when anchor is not in the ordered list", () => {
      const store = useThreadSelectionStore.getState();
      store.toggleThread(THREAD_A); // anchor = A
      // Range-select with a list that does NOT contain the anchor
      store.rangeSelectTo(THREAD_C, [THREAD_B, THREAD_C, THREAD_D]);

      const state = useThreadSelectionStore.getState();
      // Should have added C and reset anchor to C
      expect(state.selectedThreadKeys.has(THREAD_C)).toBe(true);
      expect(state.anchorThreadKey).toBe(THREAD_C);
    });

    it("falls back to toggle when target is not in the ordered list", () => {
      const store = useThreadSelectionStore.getState();
      store.toggleThread(THREAD_B); // anchor = B
      const unknownThread = ThreadId.makeUnsafe("thread-unknown");
      store.rangeSelectTo(unknownThread, ORDERED);

      const state = useThreadSelectionStore.getState();
      expect(state.selectedThreadKeys.has(unknownThread)).toBe(true);
      expect(state.anchorThreadKey).toBe(unknownThread);
    });

    it("selects the single thread when anchor equals target", () => {
      const store = useThreadSelectionStore.getState();
      store.toggleThread(THREAD_C); // anchor = C
      store.rangeSelectTo(THREAD_C, ORDERED); // range from C to C

      const state = useThreadSelectionStore.getState();
      expect(state.selectedThreadKeys.has(THREAD_C)).toBe(true);
      expect(state.selectedThreadKeys.size).toBe(1);
    });

    it("preserves previously selected threads outside the range", () => {
      const store = useThreadSelectionStore.getState();
      store.toggleThread(THREAD_A); // select A, anchor = A
      store.toggleThread(THREAD_B); // select B, anchor = B

      // Now shift-select from B (anchor) to D — should add B, C, D but keep A
      store.rangeSelectTo(THREAD_D, ORDERED);

      const state = useThreadSelectionStore.getState();
      expect(state.selectedThreadKeys.has(THREAD_A)).toBe(true);
      expect(state.selectedThreadKeys.has(THREAD_B)).toBe(true);
      expect(state.selectedThreadKeys.has(THREAD_C)).toBe(true);
      expect(state.selectedThreadKeys.has(THREAD_D)).toBe(true);
      expect(state.selectedThreadKeys.size).toBe(4);
    });
  });

  describe("clearSelection", () => {
    it("clears all selected threads and anchor", () => {
      const store = useThreadSelectionStore.getState();
      store.toggleThread(THREAD_A);
      store.toggleThread(THREAD_B);
      store.clearSelection();

      const state = useThreadSelectionStore.getState();
      expect(state.selectedThreadKeys.size).toBe(0);
      expect(state.anchorThreadKey).toBeNull();
    });

    it("is a no-op when already empty", () => {
      const stateBefore = useThreadSelectionStore.getState();
      stateBefore.clearSelection();
      const stateAfter = useThreadSelectionStore.getState();

      // Should be referentially the same (no unnecessary re-render)
      expect(stateAfter.selectedThreadKeys).toBe(stateBefore.selectedThreadKeys);
    });
  });

  describe("removeFromSelection", () => {
    it("removes specified threads from selection", () => {
      const store = useThreadSelectionStore.getState();
      store.toggleThread(THREAD_A);
      store.toggleThread(THREAD_B);
      store.toggleThread(THREAD_C);
      store.removeFromSelection([THREAD_A, THREAD_C]);

      const state = useThreadSelectionStore.getState();
      expect(state.selectedThreadKeys.has(THREAD_B)).toBe(true);
      expect(state.selectedThreadKeys.size).toBe(1);
    });

    it("clears anchor when the anchor thread is removed", () => {
      const store = useThreadSelectionStore.getState();
      store.toggleThread(THREAD_A);
      store.toggleThread(THREAD_B); // anchor = B
      store.removeFromSelection([THREAD_B]);

      expect(useThreadSelectionStore.getState().anchorThreadKey).toBeNull();
    });

    it("preserves anchor when the anchor thread is not removed", () => {
      const store = useThreadSelectionStore.getState();
      store.toggleThread(THREAD_A);
      store.toggleThread(THREAD_B); // anchor = B
      store.removeFromSelection([THREAD_A]);

      expect(useThreadSelectionStore.getState().anchorThreadKey).toBe(THREAD_B);
    });

    it("is a no-op when none of the specified threads are selected", () => {
      const store = useThreadSelectionStore.getState();
      store.toggleThread(THREAD_A);
      const stateBefore = useThreadSelectionStore.getState();
      store.removeFromSelection([THREAD_B, THREAD_C]);
      const stateAfter = useThreadSelectionStore.getState();

      expect(stateAfter.selectedThreadKeys).toBe(stateBefore.selectedThreadKeys);
    });
  });

  describe("hasSelection", () => {
    it("returns false when nothing is selected", () => {
      expect(useThreadSelectionStore.getState().hasSelection()).toBe(false);
    });

    it("returns true when threads are selected", () => {
      useThreadSelectionStore.getState().toggleThread(THREAD_A);
      expect(useThreadSelectionStore.getState().hasSelection()).toBe(true);
    });

    it("returns false after clearing selection", () => {
      const store = useThreadSelectionStore.getState();
      store.toggleThread(THREAD_A);
      store.clearSelection();
      expect(useThreadSelectionStore.getState().hasSelection()).toBe(false);
    });
  });
});
