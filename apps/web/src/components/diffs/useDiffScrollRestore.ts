import { useRef } from "react";

import { diffScrollPositions } from "~/diffPanelStore";
import { useStableCallback } from "~/hooks/useStableCallback";
import {
  captureDiffScrollAnchor,
  resolveDiffScrollAnchorTop,
  type DiffScrollAnchor,
} from "~/lib/diffRendering";
import type { AnnotatableCodeViewHandle } from "./AnnotatableCodeView";

type Viewer = NonNullable<ReturnType<AnnotatableCodeViewHandle["getInstance"]>>;

interface Session {
  viewer: Viewer;
  scopeKey: string | null;
  /** Restoration still waits for the saved file, or for lazy files that sat above it. */
  restoring: boolean;
  requestedFiles: boolean;
  /** The applied target, held until the viewer settles on it so capture cannot overwrite it. */
  pending: DiffScrollAnchor | null;
  frame: number | null;
}

/**
 * Remembers where each diff scope was scrolled, as a logical line anchor rather than pixels, and
 * puts a remounted viewer back there. Lazy files that were loaded are loaded again first, since
 * their heights decide where the anchor lands.
 */
export function useDiffScrollRestore({
  scopeKey,
  loadedFilePaths,
  pendingFilePaths,
  patchesPending,
  requestFile,
}: {
  scopeKey: string | null;
  loadedFilePaths: ReadonlyArray<string>;
  pendingFilePaths: ReadonlySet<string>;
  patchesPending: boolean;
  requestFile: (path: string) => void;
}) {
  const handleRef = useRef<AnnotatableCodeViewHandle | null>(null);
  const sessionRef = useRef<Session | null>(null);

  const sessionFor = useStableCallback((viewer: Viewer): Session => {
    const current = sessionRef.current;
    if (current?.viewer === viewer && current.scopeKey === scopeKey) return current;
    if (current?.frame != null) cancelAnimationFrame(current.frame);
    const anchor = (scopeKey ? diffScrollPositions.get(scopeKey) : undefined)?.anchor ?? null;
    const next: Session = {
      viewer,
      scopeKey,
      restoring: anchor !== null,
      requestedFiles: false,
      pending: anchor,
      frame: null,
    };
    sessionRef.current = next;
    return next;
  });

  const capture = useStableCallback((session: Session) => {
    // A frame queued before a scope switch must not save the new scope's files under the old one.
    if (sessionRef.current !== session || session.scopeKey !== scopeKey || session.restoring) {
      return;
    }
    const { viewer } = session;
    if (session.pending) {
      const top = resolveDiffScrollAnchorTop(viewer, session.pending);
      if (top === null) {
        // The saved line is gone from a changed diff; keep the reader at that file instead.
        const { id } = session.pending;
        session.pending = null;
        viewer.scrollTo({ type: "item", id, align: "start", behavior: "instant" });
      } else {
        if (top === undefined || viewer.getHeight() === 0) return;
        const scrollHeight =
          viewer.getScrollHeight() +
          (viewer.getFooterElement()?.getBoundingClientRect().height ?? 0);
        // Content shorter than the viewport is still loading; it cannot reach the target yet.
        if (top > 0 && scrollHeight <= viewer.getHeight()) return;
        const target = Math.max(0, Math.min(top, scrollHeight - viewer.getHeight()));
        if (Math.abs(viewer.getScrollTop() - target) > 1) return;
        session.pending = null;
      }
    }
    const anchor = captureDiffScrollAnchor(viewer);
    if (!anchor || !session.scopeKey) return;
    diffScrollPositions.set(session.scopeKey, { anchor, loadedFilePaths });
  });

  const onScroll = useStableCallback((_scrollTop: number, viewer: Viewer) => {
    const session = sessionFor(viewer);
    if (session.restoring || session.frame !== null) return;
    // The viewer measures virtual rows after notifying scroll listeners.
    session.frame = requestAnimationFrame(() => {
      session.frame = null;
      capture(session);
    });
  });

  /** The reader took over; a restore still settling must not pull them back. */
  const stop = useStableCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    session.restoring = false;
    session.pending = null;
  });

  const flush = useStableCallback(() => {
    const viewer = handleRef.current?.getInstance();
    if (!viewer) return;
    const session = sessionFor(viewer);
    const anchor = session.pending;
    if (!session.restoring || !anchor || !session.scopeKey) return;
    const saved = diffScrollPositions.get(session.scopeKey);
    const missing = saved?.loadedFilePaths.filter((path) => pendingFilePaths.has(path)) ?? [];
    if (missing.length > 0 && !session.requestedFiles) {
      session.requestedFiles = true;
      for (const path of missing) requestFile(path);
      return;
    }
    if (missing.length > 0 && patchesPending) return;
    if (viewer.getTopForItem(anchor.id) === undefined) {
      if (viewer.getItem(anchor.id) === undefined) stop();
      return;
    }
    session.restoring = false;
    viewer.scrollTo({ ...anchor, behavior: "instant" });
    capture(session);
  });

  /** A reveal or a fold-all owns the position now; forget the saved one for this scope. */
  const discard = useStableCallback(() => {
    stop();
    const session = sessionRef.current;
    if (session?.frame != null) cancelAnimationFrame(session.frame);
    if (session) session.frame = null;
    if (scopeKey) diffScrollPositions.delete(scopeKey);
  });

  const attach = useStableCallback((handle: AnnotatableCodeViewHandle | null) => {
    handleRef.current = handle;
    flush();
  });

  return { attach, flush, onScroll, stop, discard };
}
