import { create } from "zustand";

interface ChatFindStoreState {
  open: boolean;
  /** Bumps on every show request so an already-open bar refocuses its input. */
  focusRequestId: number;
  show: () => void;
  hide: () => void;
}

/** Find-in-thread visibility, shared by the keybinding, the command palette, and the bar. */
export const useChatFindStore = create<ChatFindStoreState>()((set) => ({
  open: false,
  focusRequestId: 0,
  show: () => set((state) => ({ open: true, focusRequestId: state.focusRequestId + 1 })),
  hide: () => set({ open: false }),
}));
