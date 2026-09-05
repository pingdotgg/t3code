import { type ReactNode, useEffect, useRef } from "react";

import {
  approximateSourceLineScrollTop,
  type FileScrollSurface,
  readFileScrollPosition,
  rememberFileScrollPosition,
  resolveRestoredFileScrollTop,
} from "~/fileScrollState";
import {
  rememberFileScrollPositionFromViewport,
  resolveFileScrollAnchorTop,
} from "./fileScrollViewport";

const FILE_SCROLL_RESTORE_MAX_ATTEMPTS = 30;

function rememberFileScrollOffsetFromViewport(input: {
  positionKey: string;
  viewport: HTMLElement;
  surface: FileScrollSurface;
}): void {
  rememberFileScrollPosition(
    input.positionKey,
    input.viewport.scrollTop,
    Math.max(0, input.viewport.scrollHeight - input.viewport.clientHeight),
    { surface: input.surface, anchorLine: null },
  );
}

export function RestorableFileScroll({
  positionKey,
  restorePosition = true,
  sourceLineCount,
  surface,
  viewportSelector,
  children,
}: {
  positionKey: string | null;
  restorePosition?: boolean;
  sourceLineCount: number;
  surface: FileScrollSurface;
  viewportSelector: string;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  // Read through a ref so content edits, which change the line count, do not restart restoration.
  const sourceLineCountRef = useRef(sourceLineCount);
  useEffect(() => {
    sourceLineCountRef.current = sourceLineCount;
  }, [sourceLineCount]);

  useEffect(() => {
    if (positionKey === null) return;
    const viewport = rootRef.current?.querySelector<HTMLElement>(viewportSelector);
    if (!viewport) return;

    const savedPosition = restorePosition ? readFileScrollPosition(positionKey) : null;
    let restoreFrame: number | null = null;
    let rememberFrame: number | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let mutationObserver: MutationObserver | null = null;
    let restoring = restorePosition && savedPosition !== null;
    let restoreAttempts = 0;

    const rememberPosition = () => {
      rememberFileScrollOffsetFromViewport({ positionKey, viewport, surface });
    };
    const scheduleRememberPosition = () => {
      if (rememberFrame !== null) return;
      rememberFrame = requestAnimationFrame(() => {
        rememberFrame = null;
        if (viewport.isConnected) rememberPosition();
      });
    };
    const disconnectGeometryObservers = () => {
      resizeObserver?.disconnect();
      resizeObserver = null;
      mutationObserver?.disconnect();
      mutationObserver = null;
    };
    const stopRestore = () => {
      restoring = false;
      disconnectGeometryObservers();
      if (restoreFrame !== null) {
        cancelAnimationFrame(restoreFrame);
        restoreFrame = null;
      }
    };
    const cancelRestore = () => {
      if (!restoring) return;
      stopRestore();
      scheduleRememberPosition();
    };
    const applySavedPosition = () => {
      restoreFrame = null;
      if (!restoring || !viewport.isConnected || savedPosition === null) return;
      const scrollRange = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      // Nothing scrollable yet: content is still mounting. Retry for a bounded number of frames
      // so a file that stays empty still ends restoration.
      if (savedPosition.scrollRange > 0 && scrollRange === 0) {
        if (restoreAttempts < FILE_SCROLL_RESTORE_MAX_ATTEMPTS) {
          restoreAttempts += 1;
          restoreFrame = requestAnimationFrame(applySavedPosition);
          return;
        }
        stopRestore();
        return;
      }
      const crossesSurfaces =
        savedPosition.surface !== surface && savedPosition.anchorLine !== null;
      const anchorScrollTop =
        crossesSurfaces && savedPosition.anchorLine !== null
          ? resolveFileScrollAnchorTop(viewport, surface, savedPosition.anchorLine)
          : null;
      let target = resolveRestoredFileScrollTop(savedPosition, scrollRange, {
        surface,
        anchorScrollTop,
      });
      if (
        crossesSurfaces &&
        anchorScrollTop === null &&
        surface === "source" &&
        savedPosition.anchorLine !== null
      ) {
        target = approximateSourceLineScrollTop(
          savedPosition.anchorLine,
          sourceLineCountRef.current,
          scrollRange,
        );
      }
      if (target !== null && Math.abs(viewport.scrollTop - target) > 1) {
        viewport.scrollTop = target;
      }
      if (
        crossesSurfaces &&
        anchorScrollTop === null &&
        restoreAttempts < FILE_SCROLL_RESTORE_MAX_ATTEMPTS
      ) {
        restoreAttempts += 1;
        restoreFrame = requestAnimationFrame(applySavedPosition);
        return;
      }
      // Content still loading (images, deferred blocks) leaves the document shorter than when the
      // position was saved. Retry for a bounded number of frames so late growth re-applies the
      // target, then finish even if the file is now genuinely shorter.
      if (
        scrollRange < savedPosition.scrollRange &&
        restoreAttempts < FILE_SCROLL_RESTORE_MAX_ATTEMPTS
      ) {
        restoreAttempts += 1;
        restoreFrame = requestAnimationFrame(applySavedPosition);
        return;
      }
      // Restore is done. Later scrolls, including programmatic ones, are the user's new position.
      stopRestore();
    };
    // Observers and scroll events fire many times while the file content mounts. Each restore
    // attempt reads scroll geometry, which forces layout, so coalesce them to one read per frame.
    const scheduleApplySavedPosition = () => {
      if (!restoring || restoreFrame !== null) return;
      restoreFrame = requestAnimationFrame(applySavedPosition);
    };
    const handleScroll = () => {
      if (restoring) {
        scheduleApplySavedPosition();
      } else {
        scheduleRememberPosition();
      }
    };

    viewport.addEventListener("scroll", handleScroll, { passive: true });
    viewport.addEventListener("wheel", cancelRestore, { passive: true });
    viewport.addEventListener("touchstart", cancelRestore, { passive: true });
    viewport.addEventListener("pointerdown", cancelRestore, { passive: true });
    viewport.addEventListener("keydown", cancelRestore);
    if (restorePosition && savedPosition === null) {
      viewport.scrollTop = 0;
    } else if (savedPosition !== null) {
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(scheduleApplySavedPosition);
        resizeObserver.observe(viewport);
        const content = viewport.firstElementChild;
        if (content) resizeObserver.observe(content);
      }
      if (typeof MutationObserver !== "undefined") {
        mutationObserver = new MutationObserver(scheduleApplySavedPosition);
        mutationObserver.observe(viewport, {
          attributes: true,
          attributeFilter: ["style"],
          childList: true,
          subtree: true,
        });
      }
      applySavedPosition();
      scheduleApplySavedPosition();
    }

    return () => {
      if (restoreFrame !== null) cancelAnimationFrame(restoreFrame);
      if (rememberFrame !== null) {
        cancelAnimationFrame(rememberFrame);
        if (!restoring) {
          rememberFileScrollPositionFromViewport({ positionKey, viewport, surface });
        }
      }
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      viewport.removeEventListener("scroll", handleScroll);
      viewport.removeEventListener("wheel", cancelRestore);
      viewport.removeEventListener("touchstart", cancelRestore);
      viewport.removeEventListener("pointerdown", cancelRestore);
      viewport.removeEventListener("keydown", cancelRestore);
    };
  }, [positionKey, restorePosition, surface, viewportSelector]);

  return (
    <div ref={rootRef} className="contents">
      {children}
    </div>
  );
}
