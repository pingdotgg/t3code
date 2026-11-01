import type { MessageId } from "@t3tools/contracts";
import { create } from "zustand";

interface PromptJumpTarget {
  readonly threadKey: string;
  readonly messageId: MessageId;
  readonly requestId: number;
}

interface PromptJumpState {
  readonly target: PromptJumpTarget | null;
  readonly nextRequestId: number;
  readonly request: (threadKey: string, messageId: MessageId) => void;
  readonly clear: (requestId: number) => void;
}

export const usePromptJumpStore = create<PromptJumpState>((set) => ({
  target: null,
  nextRequestId: 0,
  request: (threadKey, messageId) =>
    set((state) => {
      const requestId = state.nextRequestId + 1;
      return {
        nextRequestId: requestId,
        target: { threadKey, messageId, requestId },
      };
    }),
  clear: (requestId) =>
    set((state) => (state.target?.requestId === requestId ? { ...state, target: null } : state)),
}));

export function requestPromptJump(threadKey: string, messageId: MessageId): void {
  usePromptJumpStore.getState().request(threadKey, messageId);
}
