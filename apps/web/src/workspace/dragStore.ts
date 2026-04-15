import { create } from "zustand";

import type { ThreadSurfaceInput } from "./types";

export type WorkspaceDragItem =
  | {
      kind: "surface";
      surfaceId: string;
    }
  | {
      kind: "thread";
      input: ThreadSurfaceInput;
    };

interface WorkspaceDragStoreState {
  item: WorkspaceDragItem | null;
  clearItem: () => void;
  setItem: (item: WorkspaceDragItem) => void;
}

export const useWorkspaceDragStore = create<WorkspaceDragStoreState>()((set) => ({
  item: null,
  clearItem: () => set({ item: null }),
  setItem: (item) => set({ item }),
}));
