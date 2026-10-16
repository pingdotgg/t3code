import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import { create } from "zustand";

import { pullRequestReviewKey } from "../pullRequestReviewStore";

export interface GuideRunWatch {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly title: string | null;
  readonly previousGuideAt: string | null;
  readonly previousFailedAt: string | null;
  readonly since: number;
}

export interface GuideProgress {
  readonly position: number;
  readonly seen: ReadonlySet<number>;
}

const NO_PROGRESS: GuideProgress = { position: 0, seen: new Set() };

interface GuideRunStoreState {
  readonly watches: Readonly<Record<string, GuideRunWatch>>;
  readonly shownKey: string | null;
  readonly openRequestKey: string | null;
  readonly progress: Readonly<Record<string, GuideProgress>>;
  readonly setProgress: (key: string, change: (current: GuideProgress) => GuideProgress) => void;
  readonly watch: (watch: GuideRunWatch) => void;
  readonly settle: (key: string) => void;
  readonly setShown: (key: string | null) => void;
  readonly requestOpen: (key: string | null) => void;
}

export function guideRunKey(environmentId: EnvironmentId, reference: PullRequestRef): string {
  return `${environmentId}:${pullRequestReviewKey(reference)}`;
}

export const useGuideRunStore = create<GuideRunStoreState>()((set) => ({
  watches: {},
  shownKey: null,
  openRequestKey: null,
  progress: {},
  setProgress: (key, change) =>
    set((state) => ({
      progress: { ...state.progress, [key]: change(state.progress[key] ?? NO_PROGRESS) },
    })),
  watch: (watch) =>
    set((state) => {
      const key = guideRunKey(watch.environmentId, watch.reference);
      if (state.watches[key] !== undefined) return state;
      return { watches: { ...state.watches, [key]: watch } };
    }),
  settle: (key) =>
    set((state) => {
      if (state.watches[key] === undefined) return state;
      const { [key]: _settled, ...watches } = state.watches;
      return { watches };
    }),
  setShown: (shownKey) => set({ shownKey }),
  requestOpen: (openRequestKey) => set({ openRequestKey }),
}));

export function guideProgressKey(runKey: string, headSha: string): string {
  return `${runKey}:${headSha}`;
}

export function useGuideProgress(key: string): GuideProgress {
  return useGuideRunStore((state) => state.progress[key] ?? NO_PROGRESS);
}
