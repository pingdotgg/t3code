import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

interface ComposerAgentStore {
  /** Per thread, the named agent its messages go to. Absent means Default. */
  readonly agentByThread: Readonly<Record<string, string>>;
  readonly setAgent: (thread: ScopedThreadRef, agent: string | null) => void;
}

// A draft keeps its thread id when it is sent, so the choice carries over to the new thread.
const useComposerAgentStore = create<ComposerAgentStore>()(
  persist(
    (set) => ({
      agentByThread: {},
      setAgent: (thread, agent) =>
        set((state) => {
          const { [scopedThreadKey(thread)]: _previous, ...rest } = state.agentByThread;
          return {
            agentByThread: agent === null ? rest : { ...rest, [scopedThreadKey(thread)]: agent },
          };
        }),
    }),
    {
      name: "t3code:composer-agents:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
    },
  ),
);

export function useComposerAgent(thread: ScopedThreadRef | null): string | null {
  return useComposerAgentStore((state) =>
    thread === null ? null : (state.agentByThread[scopedThreadKey(thread)] ?? null),
  );
}

export function readComposerAgent(thread: ScopedThreadRef): string | null {
  return useComposerAgentStore.getState().agentByThread[scopedThreadKey(thread)] ?? null;
}

export function setComposerAgent(thread: ScopedThreadRef, agent: string | null): void {
  useComposerAgentStore.getState().setAgent(thread, agent);
}
