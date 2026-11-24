import {
  pinThreadRepository,
  unpinThreadRepository,
  type PinnedThreadRepository,
} from "@t3tools/client-runtime/state/thread-repositories";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

const NO_PINS: ReadonlyArray<PinnedThreadRepository> = Object.freeze([]);

const pinsKey = (ref: ScopedThreadRef) => `${ref.environmentId}\u0000${ref.threadId}`;

interface ThreadRepositoryPinsStore {
  /** Kept for the session only: a reload shows the repositories the thread changed. */
  readonly pinsByThread: Readonly<Record<string, ReadonlyArray<PinnedThreadRepository>>>;
  readonly pin: (ref: ScopedThreadRef, repository: PinnedThreadRepository) => void;
  readonly unpin: (ref: ScopedThreadRef, repositoryPath: string) => void;
}

export const useThreadRepositoryPinsStore = create<ThreadRepositoryPinsStore>((set) => ({
  pinsByThread: {},
  pin: (ref, repository) =>
    set((state) => {
      const key = pinsKey(ref);
      const current = state.pinsByThread[key] ?? NO_PINS;
      const next = pinThreadRepository(current, repository);
      return next === current ? state : { pinsByThread: { ...state.pinsByThread, [key]: next } };
    }),
  unpin: (ref, repositoryPath) =>
    set((state) => {
      const key = pinsKey(ref);
      const current = state.pinsByThread[key] ?? NO_PINS;
      const next = unpinThreadRepository(current, repositoryPath);
      return next === current ? state : { pinsByThread: { ...state.pinsByThread, [key]: next } };
    }),
}));

export function useThreadRepositoryPins(
  ref: ScopedThreadRef,
): ReadonlyArray<PinnedThreadRepository> {
  return useThreadRepositoryPinsStore((state) => state.pinsByThread[pinsKey(ref)] ?? NO_PINS);
}
