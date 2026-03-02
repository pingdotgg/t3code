/**
 * Single Zustand store for terminal UI state keyed by threadId. Used by both
 * persisted (server) threads and draft threads; threadId is stable for both.
 */

import type { ThreadId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  createDefaultThreadTerminalState,
  getDefaultThreadTerminalState,
  reduceThreadTerminalState,
  type ThreadTerminalAction,
  type ThreadTerminalState,
} from "./threadTerminalState";

export const TERMINAL_STATE_STORAGE_KEY = "t3code:terminal-state:v1";

function applyTerminalAction(
  state: Record<ThreadId, ThreadTerminalState>,
  threadId: ThreadId,
  action: ThreadTerminalAction,
): Record<ThreadId, ThreadTerminalState> {
  const current = state[threadId] ?? createDefaultThreadTerminalState();
  const next = reduceThreadTerminalState(current, action);
  if (next === current) {
    return state;
  }
  return {
    ...state,
    [threadId]: next,
  };
}

interface TerminalStateStoreState {
  terminalStateByThreadId: Record<ThreadId, ThreadTerminalState>;
  getTerminalState: (threadId: ThreadId) => ThreadTerminalState;
  setTerminalOpen: (threadId: ThreadId, open: boolean) => void;
  setTerminalHeight: (threadId: ThreadId, height: number) => void;
  splitTerminal: (threadId: ThreadId, terminalId: string) => void;
  newTerminal: (threadId: ThreadId, terminalId: string) => void;
  setActiveTerminal: (threadId: ThreadId, terminalId: string) => void;
  closeTerminal: (threadId: ThreadId, terminalId: string) => void;
  setTerminalActivity: (
    threadId: ThreadId,
    terminalId: string,
    hasRunningSubprocess: boolean,
  ) => void;
  clearTerminalState: (threadId: ThreadId) => void;
}

export const useTerminalStateStore = create<TerminalStateStoreState>()(
  persist(
    (set, get) => {
      const updateTerminal = (threadId: ThreadId, action: ThreadTerminalAction) => {
        if (threadId.length === 0) return;
        set((state) => ({
          terminalStateByThreadId: applyTerminalAction(
            state.terminalStateByThreadId,
            threadId,
            action,
          ),
        }));
      };
      return {
        terminalStateByThreadId: {},
        getTerminalState: (threadId) => {
          if (threadId.length === 0) {
            return getDefaultThreadTerminalState();
          }
          const state = get().terminalStateByThreadId[threadId];
          return state ?? getDefaultThreadTerminalState();
        },
        setTerminalOpen: (threadId, open) => updateTerminal(threadId, { type: "set-open", open }),
        setTerminalHeight: (threadId, height) =>
          updateTerminal(threadId, { type: "set-height", height }),
        splitTerminal: (threadId, terminalId) =>
          updateTerminal(threadId, { type: "split", terminalId }),
        newTerminal: (threadId, terminalId) =>
          updateTerminal(threadId, { type: "new", terminalId }),
        setActiveTerminal: (threadId, terminalId) =>
          updateTerminal(threadId, { type: "set-active", terminalId }),
        closeTerminal: (threadId, terminalId) =>
          updateTerminal(threadId, { type: "close", terminalId }),
        setTerminalActivity: (threadId, terminalId, hasRunningSubprocess) =>
          updateTerminal(threadId, { type: "set-activity", terminalId, hasRunningSubprocess }),
        clearTerminalState: (threadId) => {
          if (threadId.length === 0) return;
          set((state) => {
            if (state.terminalStateByThreadId[threadId] === undefined) {
              return state;
            }
            const { [threadId]: _removed, ...rest } = state.terminalStateByThreadId;
            return {
              terminalStateByThreadId: rest as Record<ThreadId, ThreadTerminalState>,
            };
          });
        },
      };
    },
    {
      name: TERMINAL_STATE_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        terminalStateByThreadId: state.terminalStateByThreadId,
      }),
    },
  ),
);
