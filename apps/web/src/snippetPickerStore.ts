import { create } from "zustand";

interface SnippetPickerStore {
  open: boolean;
  focusRequestId: number;
  openPicker: () => void;
  closePicker: () => void;
}

export const useSnippetPickerStore = create<SnippetPickerStore>((set) => ({
  open: false,
  focusRequestId: 0,
  openPicker: () =>
    set((state) => ({
      open: true,
      focusRequestId: state.focusRequestId + 1,
    })),
  closePicker: () => set({ open: false }),
}));
