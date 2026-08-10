import {
  type EnvironmentId,
  type PreviewAnnotationPayload,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { create } from "zustand";

import {
  hydrateImagesFromPersisted,
  type ComposerImageAttachment,
  type PersistedComposerImageAttachment,
} from "./composerDraftStore";
import type { ElementContextDraft } from "./lib/elementContext";
import type { TerminalContextDraft } from "./lib/terminalContext";
import type { ReviewCommentContext } from "./reviewCommentContext";

export const FAILED_SUBMISSION_RECOVERY_STORAGE_KEY = "t3code:failed-submission-recovery:v1";
// Browser storage is shared with composer drafts and the prompt stash. Keep a
// durable copy only when every image fits comfortably; the in-memory copy
// remains byte-for-byte faithful for the current session.
const MAX_DURABLE_IMAGE_DATA_URL_CHARS = 2_700_000;

export interface FailedSubmissionRecoverySnapshot {
  readonly sourceThreadRef: ScopedThreadRef;
  readonly messageId: string;
  readonly prompt: string;
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly terminalContexts: ReadonlyArray<TerminalContextDraft>;
  readonly elementContexts: ReadonlyArray<ElementContextDraft>;
  readonly previewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
  readonly reviewComments: ReadonlyArray<ReviewCommentContext>;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

interface PersistedFailedSubmissionRecoverySnapshot {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: string;
  readonly prompt: string;
  readonly expectedImageCount: number;
  readonly images: ReadonlyArray<PersistedComposerImageAttachment>;
  readonly terminalContexts: ReadonlyArray<TerminalContextDraft>;
  readonly elementContexts: ReadonlyArray<ElementContextDraft>;
  readonly previewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
  readonly reviewComments: ReadonlyArray<ReviewCommentContext>;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

function readPersistedSnapshots(): Record<string, PersistedFailedSubmissionRecoverySnapshot> {
  try {
    const raw = localStorage.getItem(FAILED_SUBMISSION_RECOVERY_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, PersistedFailedSubmissionRecoverySnapshot>;
  } catch {
    return {};
  }
}

function writePersistedSnapshots(
  snapshots: Readonly<Record<string, PersistedFailedSubmissionRecoverySnapshot>>,
): void {
  try {
    if (Object.keys(snapshots).length === 0) {
      localStorage.removeItem(FAILED_SUBMISSION_RECOVERY_STORAGE_KEY);
      return;
    }
    localStorage.setItem(FAILED_SUBMISSION_RECOVERY_STORAGE_KEY, JSON.stringify(snapshots));
  } catch {
    // The live snapshot remains usable. Do not advertise a partial copy after
    // reload when browser storage rejects it.
  }
}

function durableSnapshotFor(
  snapshot: FailedSubmissionRecoverySnapshot,
  images: ReadonlyArray<PersistedComposerImageAttachment>,
): PersistedFailedSubmissionRecoverySnapshot | null {
  if (images.length !== snapshot.images.length) return null;
  const totalImageChars = images.reduce((total, image) => total + image.dataUrl.length, 0);
  if (totalImageChars > MAX_DURABLE_IMAGE_DATA_URL_CHARS) return null;
  return {
    environmentId: snapshot.sourceThreadRef.environmentId,
    threadId: snapshot.sourceThreadRef.threadId,
    messageId: snapshot.messageId,
    prompt: snapshot.prompt,
    expectedImageCount: snapshot.images.length,
    images,
    terminalContexts: snapshot.terminalContexts,
    elementContexts: snapshot.elementContexts,
    previewAnnotations: snapshot.previewAnnotations,
    reviewComments: snapshot.reviewComments,
    runtimeMode: snapshot.runtimeMode,
    interactionMode: snapshot.interactionMode,
  };
}

function hydratePersistedSnapshot(
  persisted: PersistedFailedSubmissionRecoverySnapshot | undefined,
): FailedSubmissionRecoverySnapshot | null {
  if (!persisted) return null;
  try {
    const images = hydrateImagesFromPersisted(persisted.images);
    // The action must be all-or-nothing: a stale/corrupt durable image copy
    // never turns into an attractive but lossy recovery path.
    if (images.length !== persisted.expectedImageCount) return null;
    return {
      sourceThreadRef: {
        environmentId: persisted.environmentId,
        threadId: persisted.threadId,
      },
      messageId: persisted.messageId,
      prompt: persisted.prompt,
      images,
      terminalContexts: persisted.terminalContexts,
      elementContexts: persisted.elementContexts,
      previewAnnotations: persisted.previewAnnotations,
      reviewComments: persisted.reviewComments,
      runtimeMode: persisted.runtimeMode,
      interactionMode: persisted.interactionMode,
    };
  } catch {
    return null;
  }
}

interface FailedSubmissionRecoveryStoreState {
  readonly liveSnapshots: Readonly<Record<string, FailedSubmissionRecoverySnapshot>>;
  readonly persistedSnapshots: Readonly<Record<string, PersistedFailedSubmissionRecoverySnapshot>>;
  capture: (
    snapshot: FailedSubmissionRecoverySnapshot,
    persistedImages: ReadonlyArray<PersistedComposerImageAttachment>,
  ) => void;
  get: (sourceThreadRef: ScopedThreadRef) => FailedSubmissionRecoverySnapshot | null;
  remove: (sourceThreadRef: ScopedThreadRef) => void;
}

const initialPersistedSnapshots =
  typeof localStorage === "undefined" ? {} : readPersistedSnapshots();

export const useFailedSubmissionRecoveryStore = create<FailedSubmissionRecoveryStoreState>(
  (set, get) => ({
    liveSnapshots: {},
    persistedSnapshots: initialPersistedSnapshots,
    capture: (snapshot, persistedImages) => {
      const key = scopedThreadKey(snapshot.sourceThreadRef);
      const persisted = durableSnapshotFor(snapshot, persistedImages);
      set((state) => {
        const nextLive = { ...state.liveSnapshots, [key]: snapshot };
        const nextPersisted = { ...state.persistedSnapshots };
        if (persisted) {
          nextPersisted[key] = persisted;
        } else {
          delete nextPersisted[key];
        }
        writePersistedSnapshots(nextPersisted);
        return { liveSnapshots: nextLive, persistedSnapshots: nextPersisted };
      });
    },
    get: (sourceThreadRef) => {
      const key = scopedThreadKey(sourceThreadRef);
      return get().liveSnapshots[key] ?? hydratePersistedSnapshot(get().persistedSnapshots[key]);
    },
    remove: (sourceThreadRef) => {
      const key = scopedThreadKey(sourceThreadRef);
      set((state) => {
        if (!state.liveSnapshots[key] && !state.persistedSnapshots[key]) return state;
        const nextLive = { ...state.liveSnapshots };
        const nextPersisted = { ...state.persistedSnapshots };
        delete nextLive[key];
        delete nextPersisted[key];
        writePersistedSnapshots(nextPersisted);
        return { liveSnapshots: nextLive, persistedSnapshots: nextPersisted };
      });
    },
  }),
);

/**
 * React-friendly lookup that also restores a complete durable snapshot after
 * a reload. A missing image intentionally yields `null` rather than a partial
 * recovery opportunity.
 */
export function useFailedSubmissionRecoverySnapshot(
  sourceThreadRef: ScopedThreadRef | null,
): FailedSubmissionRecoverySnapshot | null {
  const key = sourceThreadRef ? scopedThreadKey(sourceThreadRef) : null;
  const liveSnapshot = useFailedSubmissionRecoveryStore((state) =>
    key ? (state.liveSnapshots[key] ?? null) : null,
  );
  const persistedSnapshot = useFailedSubmissionRecoveryStore((state) =>
    key ? state.persistedSnapshots[key] : undefined,
  );
  return liveSnapshot ?? hydratePersistedSnapshot(persistedSnapshot);
}
