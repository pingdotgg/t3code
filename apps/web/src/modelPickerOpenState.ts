import { create } from "zustand";

const useModelPickerOpenStore = create<{
  open: boolean;
  setOpen: (open: boolean) => void;
}>((set) => ({
  open: false,
  setOpen: (open) => set((current) => (current.open === open ? current : { open })),
}));

export function useModelPickerOpen(): boolean {
  return useModelPickerOpenStore((store) => store.open);
}

export function setModelPickerOpen(open: boolean): void {
  useModelPickerOpenStore.getState().setOpen(open);
}
