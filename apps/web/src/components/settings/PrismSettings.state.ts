import { createStore } from "zustand/vanilla";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  planPrismRolePatch,
  prismWriteObserved,
  type PrismWriteExpectation,
} from "./PrismSettings.logic";

type Plan = ReturnType<typeof planPrismRolePatch>;
interface PrismSaveState {
  pendingWrite: { plan: Plan; expectation: PrismWriteExpectation; acknowledged: boolean } | null;
  saveError: string | null;
  begin: (plan: Plan, expectation: PrismWriteExpectation) => boolean;
  acknowledge: (failed: ReadonlySet<EnvironmentId>) => void;
  observe: (environments: Parameters<typeof prismWriteObserved>[1]) => void;
  fail: (message: string) => void;
  setSaveError: (message: string | null) => void;
}

export function createPrismSaveStore() {
  return createStore<PrismSaveState>((set, get) => ({
    pendingWrite: null,
    saveError: null,
    begin: (plan, expectation) => {
      if (get().pendingWrite) return false;
      set({ pendingWrite: { plan, expectation, acknowledged: false }, saveError: null });
      return true;
    },
    acknowledge: (failed) => {
      const pending = get().pendingWrite;
      if (!pending) return;
      set({
        pendingWrite: {
          ...pending,
          acknowledged: true,
          plan: {
            ...pending.plan,
            serverWrites: pending.plan.serverWrites.filter(
              (write) => !failed.has(write.environmentId),
            ),
          },
        },
      });
    },
    observe: (environments) => {
      const pending = get().pendingWrite;
      if (
        pending?.acknowledged &&
        prismWriteObserved(pending.plan, environments, pending.expectation)
      ) {
        set({ pendingWrite: null });
      }
    },
    fail: (saveError) => set({ pendingWrite: null, saveError }),
    setSaveError: (saveError) => set({ saveError }),
  }));
}

// Scope navigation remounts the settings page. The write and its snapshot barrier must outlive it.
export const prismSaveStore = createPrismSaveStore();
