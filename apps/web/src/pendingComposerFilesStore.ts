import { create } from "zustand";

interface PendingComposerFilesState {
  files: File[];
  add: (files: File[]) => void;
  take: () => File[];
}

/** Files queued outside a thread (the Notes page) for the next main composer that can take them. */
export const usePendingComposerFilesStore = create<PendingComposerFilesState>()((set, get) => ({
  files: [],
  add: (files) => set((state) => ({ files: [...state.files, ...files] })),
  take: () => {
    const { files } = get();
    set({ files: [] });
    return files;
  },
}));
