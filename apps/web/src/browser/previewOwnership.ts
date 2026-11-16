import type { DesktopPreviewBridge, DesktopPreviewOwnership } from "@t3tools/contracts";
import { create } from "zustand";

/** Null until the desktop answers; a window renders no hosted webviews before it knows. */
const usePreviewOwnershipStore = create<{ ownership: DesktopPreviewOwnership | null }>(() => ({
  ownership: null,
}));

function ownsPreviewSession(ownership: DesktopPreviewOwnership, sessionKey: string): boolean {
  return (
    ownership.claimedHere.includes(sessionKey) ||
    (ownership.isHost && !ownership.claimedElsewhere.includes(sessionKey))
  );
}

/** The sessions this window hosts webviews for; another window renders the rest. */
export function ownedPreviewSessions<TSession extends { readonly sessionKey: string }>(
  sessions: readonly TSession[],
  ownership: DesktopPreviewOwnership | null,
): TSession[] {
  return ownership === null
    ? []
    : sessions.filter((session) => ownsPreviewSession(ownership, session.sessionKey));
}

export function usePreviewOwnership(): DesktopPreviewOwnership | null {
  return usePreviewOwnershipStore((state) => state.ownership);
}

function adoptOwnership(next: DesktopPreviewOwnership): void {
  const current = usePreviewOwnershipStore.getState().ownership;
  if (current !== null && current.version >= next.version) return;
  usePreviewOwnershipStore.setState({ ownership: next });
}

/** Subscribes before the first read so a change between the two is never lost. */
export function startPreviewOwnership(preview: DesktopPreviewBridge): () => void {
  const unsubscribe = preview.onOwnershipChange(adoptOwnership);
  void preview.getOwnership().then(adoptOwnership, () => undefined);
  return unsubscribe;
}

/** Moves a session's webview into this window unless it already lives here. */
export function claimPreviewSession(sessionKey: string): void {
  const preview = window.desktopBridge?.preview;
  const ownership = usePreviewOwnershipStore.getState().ownership;
  if (!preview || (ownership !== null && ownsPreviewSession(ownership, sessionKey))) return;
  void preview.claimSession(sessionKey).catch(() => undefined);
}
