/**
 * Guide runs this tab is waiting on, so the reader can leave and hear when one is done, and where
 * the reader is in each guide.
 *
 * A run takes minutes and finishes on the server. `PullRequestGuideRunCoordinator` watches every
 * run listed here, wherever the reader is in the app, and says when it ends. Progress is shared so
 * a guide opened beside a new thread picks up at the same stop. Not persisted: a reload forgets
 * both, and the guide is still there when the reader comes back.
 */
import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import { create } from "zustand";

import { pullRequestReviewKey } from "../pullRequestReviewStore";

export interface GuideRunWatch {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  /** The pull request's title, for the notice. */
  readonly title: string | null;
  /** The guide and failure on record when the wait began; a different one means the run ended. */
  readonly previousGuideAt: string | null;
  readonly previousFailedAt: string | null;
  readonly since: number;
}

/** Where a reader is in one guide, kept per guide head so any panel showing it agrees. */
export interface GuideProgress {
  readonly position: number;
  /** Stops the reader has moved on from, which the rail checks off. */
  readonly seen: ReadonlySet<number>;
}

const NO_PROGRESS: GuideProgress = { position: 0, seen: new Set() };

interface GuideRunStoreState {
  readonly watches: Readonly<Record<string, GuideRunWatch>>;
  /** The guide on screen right now, which needs no notice when it lands. */
  readonly shownKey: string | null;
  /** A guide a notice asked to open; its panel switches to the Guide tab and clears this. */
  readonly openRequestKey: string | null;
  /** Reading progress by guide, keyed by `guideProgressKey`. */
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

/** One guide's progress: a new head is a new tour, since its stops are not the ones read. */
export function guideProgressKey(runKey: string, headSha: string): string {
  return `${runKey}:${headSha}`;
}

export function useGuideProgress(key: string): GuideProgress {
  return useGuideRunStore((state) => state.progress[key] ?? NO_PROGRESS);
}
