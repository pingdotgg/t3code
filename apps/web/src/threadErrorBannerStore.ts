import { create } from "zustand";

interface ThreadErrorBannerState {
  readonly dismissedRuntimeErrorKeysByThreadKey: Record<string, string>;
  readonly dismissRuntimeError: (threadKey: string, runtimeErrorKey: string) => void;
}

export const useThreadErrorBannerStore = create<ThreadErrorBannerState>((set) => ({
  dismissedRuntimeErrorKeysByThreadKey: {},
  dismissRuntimeError: (threadKey, runtimeErrorKey) =>
    set((state) => {
      if (state.dismissedRuntimeErrorKeysByThreadKey[threadKey] === runtimeErrorKey) return state;
      return {
        dismissedRuntimeErrorKeysByThreadKey: {
          ...state.dismissedRuntimeErrorKeysByThreadKey,
          [threadKey]: runtimeErrorKey,
        },
      };
    }),
}));
