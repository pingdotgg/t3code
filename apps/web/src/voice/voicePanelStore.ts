import { create } from "zustand";

interface VoicePanelStore {
  readonly open: boolean;
  readonly openVoicePanel: () => void;
  readonly closeVoicePanel: () => void;
  readonly toggleVoicePanel: () => void;
}

export const useVoicePanelStore = create<VoicePanelStore>((set) => ({
  open: false,
  openVoicePanel: () => set({ open: true }),
  closeVoicePanel: () => set({ open: false }),
  toggleVoicePanel: () => set((state) => ({ open: !state.open })),
}));
