import { create } from "zustand";

interface BlockingOverlayStoreState {
  blockingOverlayCount: number;
  incrementBlockingOverlayCount: () => void;
  decrementBlockingOverlayCount: () => void;
}

export const useBlockingOverlayStore = create<BlockingOverlayStoreState>()((set) => ({
  blockingOverlayCount: 0,
  incrementBlockingOverlayCount: () =>
    set((state) => ({
      blockingOverlayCount: state.blockingOverlayCount + 1,
    })),
  decrementBlockingOverlayCount: () =>
    set((state) => ({
      blockingOverlayCount: Math.max(0, state.blockingOverlayCount - 1),
    })),
}));
