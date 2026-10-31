import { useSyncExternalStore } from "react";

/**
 * Dev builds only: lets the Settings > Appearance "Artwork" dropdown preview another
 * channel's artwork. Browser-local; production builds never read or honor it.
 */
const DEV_ARTWORK_PREVIEW_STAGE_LABELS = ["Nightly", "Dev"] as const;
export type DevArtworkPreviewStageLabel = (typeof DEV_ARTWORK_PREVIEW_STAGE_LABELS)[number];

const STORAGE_KEY = "t3code:dev-artwork-preview";
const listeners = new Set<() => void>();

function readDevArtworkPreview(): DevArtworkPreviewStageLabel | null {
  if (!import.meta.env.DEV) return null;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return DEV_ARTWORK_PREVIEW_STAGE_LABELS.find((label) => label === stored) ?? null;
}

export function setDevArtworkPreview(label: DevArtworkPreviewStageLabel | null): void {
  if (!import.meta.env.DEV) return;
  if (label === null) window.localStorage.removeItem(STORAGE_KEY);
  else window.localStorage.setItem(STORAGE_KEY, label);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDevArtworkPreview(): DevArtworkPreviewStageLabel | null {
  return useSyncExternalStore(subscribe, readDevArtworkPreview, () => null);
}
