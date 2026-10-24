/** Anchors composer suggestions independently of the scrolling editor surface. */
import { type ReactNode, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { observeResize } from "~/lib/observeResize";
import { useComposerViewport } from "./ComposerViewport";
import {
  composerCommandMenuPosition,
  type ComposerCommandMenuPosition,
} from "./composerCommandMenuPosition";

function composerCommandMenuPositionsEqual(
  a: ComposerCommandMenuPosition,
  b: ComposerCommandMenuPosition,
): boolean {
  return (
    a.bottom === b.bottom &&
    a.left === b.left &&
    a.maxHeight === b.maxHeight &&
    a.width === b.width &&
    a.top === b.top
  );
}

export function ComposerCommandMenuLayer(props: {
  anchor: HTMLElement | null;
  children: ReactNode;
}) {
  const [position, setPosition] = useState<ComposerCommandMenuPosition | null>(null);
  const { maximized } = useComposerViewport();

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
      const selection = window.getSelection();
      const caret =
        maximized &&
        selection?.rangeCount &&
        selection.anchorNode &&
        form?.contains(selection.anchorNode)
          ? selection.getRangeAt(0).getBoundingClientRect()
          : null;
      const next = composerCommandMenuPosition({
        rect,
        caret,
        maximized,
        viewportHeight: window.innerHeight,
        rootFontSize: rootFontSizePx,
        drawerInset,
      });
      if (!next) {
        setPosition(null);
        return;
      }
      setPosition((current) =>
        current && composerCommandMenuPositionsEqual(current, next) ? current : next,
      );
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    if (maximized) document.addEventListener("selectionchange", updatePosition);

    const observed: Element[] = [anchor];
    for (let element = anchor.parentElement; element; element = element.parentElement) {
      observed.push(element);
    }
    const stopObserving = observeResize(observed, updatePosition);

    return () => {
      stopObserving();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      document.removeEventListener("selectionchange", updatePosition);
    };
  }, [props.anchor, maximized]);

  if (!props.anchor || !position) return null;

  return createPortal(
    <div
      className="pointer-events-auto fixed z-40 flex flex-col"
      data-composer-drawer-layer="true"
      style={{
        bottom: position.bottom,
        top: position.top,
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
