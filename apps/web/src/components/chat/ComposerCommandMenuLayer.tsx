import { type ReactNode, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { observeResize } from "~/lib/observeResize";

type ComposerCommandMenuPosition = {
  bottom: number;
  left: number;
  maxHeight: number;
  width: number;
};

function composerCommandMenuPositionsEqual(
  a: ComposerCommandMenuPosition,
  b: ComposerCommandMenuPosition,
): boolean {
  return (
    a.bottom === b.bottom && a.left === b.left && a.maxHeight === b.maxHeight && a.width === b.width
  );
}

// The gap between the tray and a menu floating above it, and the pen's widest menu.
const COMPOSER_MENU_GAP_PX = 8;
export const COMPOSER_MENU_MAX_WIDTH_PX = 520;

/** Floats a menu above the composer tray, aligned with its left edge. */
export function ComposerCommandMenuLayer(props: {
  anchor: HTMLElement | null;
  maxWidth?: number;
  children: ReactNode;
}) {
  const { maxWidth } = props;
  const [position, setPosition] = useState<ComposerCommandMenuPosition | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- positions the menu from the composer's DOM rect, tracking window resize, scroll and ancestor resizes
  useLayoutEffect(() => {
    const anchor = props.anchor;
    if (!anchor) return;

    const updatePosition = () => {
      const tray =
        anchor.closest<HTMLElement>('[data-slot="composer-shell"]') ??
        anchor.closest<HTMLElement>('[data-chat-composer-form="true"]') ??
        anchor;
      const rect = tray.getBoundingClientRect();
      const width = maxWidth === undefined ? rect.width : Math.min(rect.width, maxWidth);
      if (width <= 0) {
        setPosition(null);
        return;
      }
      const next = {
        bottom: window.innerHeight - rect.top + COMPOSER_MENU_GAP_PX,
        left: rect.left,
        maxHeight: Math.max(96, rect.top - 24 - COMPOSER_MENU_GAP_PX),
        width,
      };
      setPosition((current) =>
        current && composerCommandMenuPositionsEqual(current, next) ? current : next,
      );
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);

    const observed: Element[] = [anchor];
    for (let element = anchor.parentElement; element; element = element.parentElement) {
      observed.push(element);
    }
    const stopObserving = observeResize(observed, updatePosition);

    return () => {
      stopObserving();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [props.anchor, maxWidth]);

  if (!props.anchor || !position) return null;

  return createPortal(
    <div
      className="pointer-events-auto fixed z-40 flex flex-col"
      data-composer-drawer-layer="true"
      style={{
        bottom: position.bottom,
        left: position.left,
        maxHeight: position.maxHeight,
        width: position.width,
      }}
    >
      {props.children}
    </div>,
    document.body,
  );
}
