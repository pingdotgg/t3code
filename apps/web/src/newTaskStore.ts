import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

/** A task a new-thread draft will create when it is sent; nothing exists on the server until then. */
export interface NewTaskPlan {
  readonly title: string;
  readonly description: string;
  readonly directory: string | null;
  readonly enrich: boolean;
}

interface NewTaskStoreState {
  /** Keyed by the task id the draft already carries, so the file gets that id when it is made. */
  readonly byId: Readonly<Record<string, NewTaskPlan>>;
  readonly plan: (taskDocumentId: string, plan: NewTaskPlan) => void;
  readonly forget: (taskDocumentId: string) => void;
}

export const useNewTaskStore = create<NewTaskStoreState>()(
  persist(
    (set) => ({
      byId: {},
      plan: (taskDocumentId, plan) =>
        set((state) => ({ byId: { ...state.byId, [taskDocumentId]: plan } })),
      forget: (taskDocumentId) =>
        set((state) => {
          if (!(taskDocumentId in state.byId)) return state;
          const { [taskDocumentId]: _forgotten, ...byId } = state.byId;
          return { byId };
        }),
    }),
    {
      name: "t3code:new-tasks:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      version: 1,
      partialize: ({ byId }) => ({ byId }),
    },
  ),
);
