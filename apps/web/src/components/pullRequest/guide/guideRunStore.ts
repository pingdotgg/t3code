import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import { create } from "zustand";

import type { PullRequestDetailTab } from "~/rightPanelStore";

import { pullRequestReviewKey } from "../pullRequestReviewStore";

export interface GuideRunWatch {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly title: string | null;
  readonly previousGuideAt: string | null;
  readonly previousFailedAt: string | null;
  readonly since: number;
  /**
   * Registered from a server answer that reports the run as Running. The guide atom still holds
   * the previous answer then, and its outcome belongs to an earlier run.
   */
  readonly answeredRunning?: boolean;
}

export interface GuideProgress {
  readonly position: number;
  readonly seen: ReadonlySet<number>;
}

const NO_PROGRESS: GuideProgress = { position: 0, seen: new Set() };

interface GuideRunStoreState {
  readonly watches: Readonly<Record<string, GuideRunWatch>>;
  /** The tab the pull requests page shows, for the pull request (run key) it was chosen on. */
  readonly pageDetailTab: { readonly key: string; readonly tab: PullRequestDetailTab } | null;
  readonly progress: Readonly<Record<string, GuideProgress>>;
  readonly setProgress: (key: string, change: (current: GuideProgress) => GuideProgress) => void;
  readonly watch: (watch: GuideRunWatch) => void;
  readonly settle: (key: string) => void;
  readonly showPageDetailTab: (key: string, tab: PullRequestDetailTab) => void;
}

export function guideRunKey(environmentId: EnvironmentId, reference: PullRequestRef): string {
  return `${environmentId}:${pullRequestReviewKey(reference)}`;
}

export const useGuideRunStore = create<GuideRunStoreState>()((set) => ({
  watches: {},
  pageDetailTab: null,
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
  showPageDetailTab: (key, tab) => set({ pageDetailTab: { key, tab } }),
}));

export function guideProgressKey(runKey: string, headSha: string): string {
  return `${runKey}:${headSha}`;
}

export function useGuideProgress(key: string): GuideProgress {
  return useGuideRunStore((state) => state.progress[key] ?? NO_PROGRESS);
}
