import { type ReactNode, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { observeResize } from "~/lib/observeResize";

type ComposerCommandMenuPosition = {
  container: HTMLElement;
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
    a.container === b.container &&
    a.bottom === b.bottom &&
    a.left === b.left &&
    a.maxHeight === b.maxHeight &&
    a.width === b.width
  );
}

export function ComposerCommandMenuLayer(props: {
  anchor: HTMLElement | null;
  children: ReactNode;
}) {
  const [position, setPosition] = useState<ComposerCommandMenuPosition | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- positions the menu from the composer's DOM rect, tracking window resize, scroll and ancestor resizes
  useLayoutEffect(() => {
    const anchor = props.anchor;
    if (!anchor) return;

    const updatePosition = () => {
      const form = anchor.closest<HTMLElement>('[data-chat-composer-form="true"]');
      const mainSurface = form?.querySelector<HTMLElement>(
        '[data-chat-composer-main-surface="true"]',
      );
      const rect = (mainSurface ?? form ?? anchor).getBoundingClientRect();
      const rootFontSizePx =
        Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
      const drawerInsetRem = Number.parseFloat(
        window.getComputedStyle(form ?? anchor).getPropertyValue("--chat-composer-drawer-inset"),
      );
      const drawerInset = drawerInsetRem * rootFontSizePx;
      const width = rect.width - drawerInset * 2;
      if (width <= 0) {
        setPosition(null);
        return;
      }
      const composerOverlap = rootFontSizePx + 1;
      // While the shell is pinned over Safari's keyboard it is the containing block for fixed
      // descendants (see index.css), so the menu renders inside it and is placed relative to it.
      const shell =
        document.documentElement.dataset.keyboardViewport === undefined
          ? null
          : anchor.closest<HTMLElement>('[data-slot="sidebar-wrapper"]');
      const frame = shell?.getBoundingClientRect() ?? {
        top: 0,
        left: 0,
        bottom: document.documentElement.clientHeight,
      };
      const next = {
        container: shell ?? document.body,
        bottom: frame.bottom - rect.top - composerOverlap,
        left: rect.left - frame.left + drawerInset,
        maxHeight: Math.max(96, rect.top - frame.top - 24 + composerOverlap),
        width,
      };
      setPosition((current) =>
        current && composerCommandMenuPositionsEqual(current, next) ? current : next,
      );
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    // The shell is pinned and unpinned on visual viewport changes, which fire no window events.
    window.visualViewport?.addEventListener("resize", updatePosition);
    window.visualViewport?.addEventListener("scroll", updatePosition);

    const observed: Element[] = [anchor];
    for (let element = anchor.parentElement; element; element = element.parentElement) {
      observed.push(element);
    }
    const stopObserving = observeResize(observed, updatePosition);

    return () => {
      stopObserving();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      window.visualViewport?.removeEventListener("resize", updatePosition);
      window.visualViewport?.removeEventListener("scroll", updatePosition);
    };
  }, [props.anchor]);

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
    position.container,
  );
}
