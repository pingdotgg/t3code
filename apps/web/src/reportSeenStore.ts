/**
 * Which PostHog reports this client has read, and when. Backed by local
 * storage so the inbox keeps its unread marks across reloads, and held in a
 * store so the list and the reading view agree without a reload.
 */
import { create } from "zustand";

import { readReportSeenMap, writeReportSeenMap } from "./clientPersistenceStorage";

interface ReportSeenStore {
  readonly seenByReportId: Readonly<Record<string, string>>;
  /** Record that the user opened a report at its current `updated_at`. */
  readonly markSeen: (reportId: string, updatedAt: string) => void;
}

export const useReportSeenStore = create<ReportSeenStore>((set, get) => ({
  seenByReportId: readReportSeenMap(),
  markSeen: (reportId, updatedAt) => {
    const current = get().seenByReportId;
    if (current[reportId] === updatedAt) return;
    const next = { ...current, [reportId]: updatedAt };
    writeReportSeenMap(next);
    set({ seenByReportId: next });
  },
}));

export const selectReportSeenMap = (state: ReportSeenStore) => state.seenByReportId;
export const selectMarkReportSeen = (state: ReportSeenStore) => state.markSeen;
