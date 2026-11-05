import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { request } from "@t3tools/client-runtime/rpc";
import { createEnvironmentQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import {
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { createContext, useContext, type ReactNode } from "react";
import { create } from "zustand";
import { connectionAtomRuntime } from "./connection/runtime";
import { useThreadRefs, useThreadShells } from "./state/entities";
import { useEnvironments } from "./state/environments";
import { useDebouncedValue } from "./state/queries";

interface HighlightState {
  hovered: ScopedThreadRef | null;
  pinned: ScopedThreadRef | null;
  enter: (target: ScopedThreadRef) => void;
  leave: (target: ScopedThreadRef) => void;
  togglePinned: (target: ScopedThreadRef) => void;
}
const key = (ref: ScopedThreadRef) => scopedThreadKey(ref);
export const useThreadReferenceHighlight = create<HighlightState>((set) => ({
  hovered: null,
  pinned: null,
  enter: (target) => set({ hovered: target }),
  leave: (target) =>
    set((state) =>
      state.hovered && key(state.hovered) === key(target) ? { hovered: null } : state,
    ),
  togglePinned: (target) =>
    set((state) => ({
      pinned: state.pinned && key(state.pinned) === key(target) ? null : target,
    })),
}));

const references = createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
  label: "thread-references",
  staleTimeMs: 0,
  idleTtlMs: 10_000,
  execute: Effect.fn("ThreadReferences.read")(function* (input: {
    sourceEnvironmentId: EnvironmentId;
    target: ScopedThreadRef;
    knownThreads: ReadonlyArray<ScopedThreadRef>;
    version: string;
  }) {
    const { version: _version, ...requestInput } = input;
    return yield* request(ORCHESTRATION_V2_WS_METHODS.getThreadReferences, requestInput);
  }),
});
const results = Atom.family((encoded: string) => {
  const { target, knownThreads, version, environments } = JSON.parse(encoded) as {
    target: ScopedThreadRef;
    knownThreads: ReadonlyArray<ScopedThreadRef>;
    version: string;
    environments: ReadonlyArray<EnvironmentId>;
  };
  return Atom.make((get) => {
    const mentions: string[] = [];
    const waits: string[] = [];
    let unavailable = 0;
    let pending = false;
    for (const environmentId of environments) {
      const result = get(
        references({
          environmentId,
          input: { sourceEnvironmentId: environmentId, target, knownThreads, version },
        }),
      );
      const data = AsyncResult.getOrElse(result, () => null);
      if (data) {
        mentions.push(...data.mentions.map((threadId) => key({ environmentId, threadId })));
        waits.push(...data.waits.map((threadId) => key({ environmentId, threadId })));
      }
      if (AsyncResult.isFailure(result)) unavailable++;
      if (result.waiting) pending = true;
    }
    return { mentions, waits, unavailable, pending };
  });
});
const empty = Atom.make({
  mentions: [] as string[],
  waits: [] as string[],
  unavailable: 0,
  pending: false,
});

interface HighlightInfo {
  keys: ReadonlySet<string>;
  target: string | null;
  mentions: number;
  waits: number;
  unavailable: number;
  pending: boolean;
}
const HighlightContext = createContext<HighlightInfo>({
  keys: new Set(),
  target: null,
  mentions: 0,
  waits: 0,
  unavailable: 0,
  pending: false,
});
export const useReferenceHighlighted = (threadKey: string) =>
  useContext(HighlightContext).keys.has(threadKey);
export const useReferenceInfo = (threadKey: string) => {
  const info = useContext(HighlightContext);
  return info.target === threadKey ? info : null;
};

export function ThreadReferenceHighlightProvider({ children }: { children: ReactNode }) {
  const hovered = useThreadReferenceHighlight((state) => state.hovered);
  const pinned = useThreadReferenceHighlight((state) => state.pinned);
  const target = hovered ?? pinned;
  const settledTarget = useDebouncedValue(target, 200);
  const current =
    target !== null && settledTarget !== null && key(target) === key(settledTarget) ? target : null;
  const knownThreads = useThreadRefs(current !== null);
  const { environments } = useEnvironments();
  const shells = useThreadShells(current !== null);
  const version = JSON.stringify(
    shells.map((thread) => [
      thread.environmentId,
      thread.id,
      thread.blockedOnThreadWait,
      thread.pendingBackgroundTasks,
      thread.updatedAt,
    ]),
  );
  const settledVersion = useDebouncedValue(version, 500);
  const encoded =
    current === null
      ? null
      : JSON.stringify({
          target: current,
          knownThreads,
          version: settledVersion,
          environments: environments.map((env) => env.environmentId),
        });
  const matches = useAtomValue(encoded === null ? empty : results(encoded));
  const mentionKeys = new Set(current ? matches.mentions : []);
  const waitKeys = new Set(current ? matches.waits : []);
  if (current && target)
    for (const thread of shells) {
      if (thread.environmentId !== target.environmentId) continue;
      if (
        thread.pendingBackgroundTasks?.some(
          (task) => task.kind === "subagent" && task.childThreadId === target.threadId,
        )
      )
        waitKeys.add(key({ environmentId: thread.environmentId, threadId: thread.id }));
    }
  const keys = new Set([...mentionKeys, ...waitKeys]);
  if (target) keys.add(key(target));
  return (
    <HighlightContext.Provider
      value={{
        keys,
        target: target ? key(target) : null,
        mentions: mentionKeys.size,
        waits: waitKeys.size,
        unavailable: matches.unavailable,
        pending: current === null || matches.pending,
      }}
    >
      {children}
    </HighlightContext.Provider>
  );
}
