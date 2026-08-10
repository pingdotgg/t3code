/**
 * Which thread reviewed which pull request.
 *
 * Only the thread id is stored. Run state (running / done / failed) is read
 * live from the thread projection instead of being mirrored here, so a review
 * cannot get stuck showing "Reviewing..." because a status write was missed.
 */
import type {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  ThreadId,
} from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

const CODE_REVIEW_STORAGE_KEY = "t3code:code-reviews:v1";
const CODE_REVIEW_STORAGE_VERSION = 1;

export interface CodeReviewRef {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly provider: SourceControlProviderKind;
  readonly number: number;
}

export interface CodeReviewEntry {
  readonly threadId: ThreadId;
  readonly startedAt: string;
}

interface CodeReviewStoreState {
  byKey: Record<string, CodeReviewEntry>;
  record: (ref: CodeReviewRef, entry: CodeReviewEntry) => void;
  forget: (ref: CodeReviewRef) => void;
}

/**
 * Scoped by project as well as provider: the same PR number exists in every
 * repository, and two projects can point at different repos.
 */
export function codeReviewKey(ref: CodeReviewRef): string {
  return `${ref.environmentId}:${ref.projectId}:${ref.provider}:${ref.number}`;
}

export function migratePersistedCodeReviewState(persistedState: unknown): {
  byKey: Record<string, CodeReviewEntry>;
} {
  if (!persistedState || typeof persistedState !== "object" || !("byKey" in persistedState)) {
    return { byKey: {} };
  }
  const rawByKey = (persistedState as { byKey: unknown }).byKey;
  if (!rawByKey || typeof rawByKey !== "object") {
    return { byKey: {} };
  }
  const byKey: Record<string, CodeReviewEntry> = {};
  for (const [key, value] of Object.entries(rawByKey as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Partial<CodeReviewEntry>;
    if (typeof entry.threadId !== "string" || entry.threadId.length === 0) continue;
    byKey[key] = {
      threadId: entry.threadId as ThreadId,
      startedAt: typeof entry.startedAt === "string" ? entry.startedAt : "",
    };
  }
  return { byKey };
}

export const useCodeReviewStore = create<CodeReviewStoreState>()(
  persist(
    (set) => ({
      byKey: {},
      record: (ref, entry) =>
        set((state) => ({ byKey: { ...state.byKey, [codeReviewKey(ref)]: entry } })),
      forget: (ref) =>
        set((state) => {
          const key = codeReviewKey(ref);
          if (!(key in state.byKey)) return state;
          const { [key]: _removed, ...rest } = state.byKey;
          return { byKey: rest };
        }),
    }),
    {
      name: CODE_REVIEW_STORAGE_KEY,
      version: CODE_REVIEW_STORAGE_VERSION,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ byKey: state.byKey }),
      migrate: migratePersistedCodeReviewState,
    },
  ),
);

export function selectCodeReview(
  byKey: Record<string, CodeReviewEntry>,
  ref: CodeReviewRef | null,
): CodeReviewEntry | null {
  if (ref === null) return null;
  return byKey[codeReviewKey(ref)] ?? null;
}
