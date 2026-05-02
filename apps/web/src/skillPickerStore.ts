import { create } from "zustand";

interface SkillPickerStore {
  open: boolean;
  focusRequestId: number;
  openPicker: () => void;
  closePicker: () => void;
}

export const useSkillPickerStore = create<SkillPickerStore>((set) => ({
  open: false,
  focusRequestId: 0,
  openPicker: () =>
    set((state) => ({
      open: true,
      focusRequestId: state.focusRequestId + 1,
    })),
  closePicker: () => set({ open: false }),
}));
