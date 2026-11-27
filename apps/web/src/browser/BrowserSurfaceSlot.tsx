import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { acquireBrowserSurface, useBrowserSurfaceStore } from "./browserSurfaceStore";
import { observeResize } from "../lib/observeResize";

export function BrowserSurfaceSlot(props: {
  readonly tabId: string;
  readonly visible: boolean;
  readonly cornerRadius?: number;
  readonly zIndex?: number;
  readonly layoutVersion?: string | number;
  readonly className?: string;
  readonly fitSourceContent?: boolean;
  /** Page overlays (find bar, agent cursor) that must paint above the webview. */
  readonly children?: ReactNode;
}) {
  const {
    tabId,
    visible,
    cornerRadius = 0,
    zIndex = 30,
    layoutVersion,
    className,
    fitSourceContent = false,
    children,
  } = props;
  const presentationRef = useRef({ visible, cornerRadius, zIndex });
  const updateRef = useRef<(() => void) | null>(null);
  const [lifted, setLifted] = useState<{ zIndex: number; container: Element } | null>(null);
  const liftedRect = useBrowserSurfaceStore((state) =>
    lifted === null ? null : (state.byTabId[tabId]?.rect ?? null),
  );

  // The lease lives as long as this element for one tab, so the ref callback owns it.
  const attachSurface = (element: HTMLDivElement) => {
    let lease = acquireBrowserSurface(tabId, fitSourceContent);
    // The webview lives in a fixed layer outside the slot, so a sheet's stacking context would cover
    // it. Lift it above the sheet, and its overlays with it, since they cannot leave the sheet's context.
    const sheet = element.closest('[data-slot="sheet-viewport"]');
    const minZIndex = sheet ? Number(getComputedStyle(sheet).zIndex) + 1 || 0 : 0;
    if (sheet?.parentElement && minZIndex > 0) {
      setLifted({ zIndex: minZIndex, container: sheet.parentElement });
    }
    const update = () => {
      const rect = element.getBoundingClientRect();
      const presentation = presentationRef.current;
      const zIndex = Math.max(presentation.zIndex, minZIndex);
      const presented = lease.present(
        {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.max(1, Math.round(rect.width)),
          height: Math.max(1, Math.round(rect.height)),
        },
        presentation.visible && rect.width > 0 && rect.height > 0,
        presentation.cornerRadius,
        zIndex,
      );
      if (presentation.visible && !presented) {
        lease.release();
        lease = acquireBrowserSurface(tabId, fitSourceContent);
        lease.present(
          {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.max(1, Math.round(rect.width)),
            height: Math.max(1, Math.round(rect.height)),
          },
          rect.width > 0 && rect.height > 0,
          presentation.cornerRadius,
          zIndex,
        );
      }
    };
    updateRef.current = update;
    update();
    const observed: Element[] = [element];
    // Inline shells animate without resizing the slot, so observe the shell too.
    const panel = element.closest('[data-preview-panel-mode="inline"]');
    if (panel) observed.push(panel);
    // Sidebar width changes move the slot without changing its size or column offset.
    observed.push(...document.querySelectorAll('[data-slot="sidebar-gap"]'));
    const stopObserving = observeResize(observed, update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      stopObserving();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      if (updateRef.current === update) updateRef.current = null;
      lease.release();
    };
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes visibility, radius and stacking to the desktop browser surface after layout
  useLayoutEffect(() => {
    presentationRef.current = { visible, cornerRadius, zIndex };
    updateRef.current?.();
  }, [
    cornerRadius,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A layoutVersion bump means the slot moved without resizing, so it re-presents at the new position.
    layoutVersion,
    visible,
    zIndex,
  ]);

  return (
    <>
      <div ref={attachSurface} className={className} data-browser-surface-slot={tabId} />
      {lifted === null
        ? children
        : liftedRect && visible
          ? createPortal(
              // In the sheet's portal and marked as a nested portal, so the dialog keeps treating
              // it as its own content for focus, outside presses and aria-hidden.
              <div
                className="pointer-events-none fixed overflow-hidden"
                style={{
                  left: liftedRect.x,
                  top: liftedRect.y,
                  width: liftedRect.width,
                  height: liftedRect.height,
                  zIndex: Math.max(zIndex, lifted.zIndex) + 1,
                }}
                data-browser-surface-overlay={tabId}
                data-base-ui-portal=""
              >
                {children}
              </div>,
              lifted.container,
            )
          : null}
    </>
  );
}
