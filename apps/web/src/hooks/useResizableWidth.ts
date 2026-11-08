import * as Schema from "effect/Schema";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useLayoutEffect,
  useState,
} from "react";

import { getLocalStorageItem, setLocalStorageItem } from "./useLocalStorage";
import { useResizeDrag } from "./useResizeDrag";
import { useStableCallback } from "./useStableCallback";

const WidthSchema = Schema.Finite;

/** The host must size itself from this custom property. */
export const RESIZABLE_WIDTH_PROPERTY = "--resizable-width";

export interface UseResizableWidthOptions {
  readonly storageKey: string;
  readonly defaultWidth: number;
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly edge: "left" | "right";
}

export interface ResizableWidthHandlers {
  readonly ref: (node: HTMLElement | null) => (() => void) | undefined;
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onLostPointerCapture: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly tabIndex: 0;
  readonly "aria-valuenow": number;
  readonly "aria-valuemin": number;
  readonly "aria-valuemax": number;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
}

/** Uses the current default until a width is chosen; persists on drag end, not every frame. */
export function useResizableWidth(options: UseResizableWidthOptions): {
  readonly width: number;
  readonly setWidth: (width: number) => void;
  readonly handlers: ResizableWidthHandlers;
} {
  const { storageKey, defaultWidth, minWidth, maxWidth, edge } = options;

  const clamp = (value: number): number => {
    if (!Number.isFinite(value)) return defaultWidth;
    return Math.max(minWidth, Math.min(maxWidth, value));
  };

  const readWidth = (): number | null => {
    if (typeof window === "undefined") return null;
    try {
      const stored = getLocalStorageItem(storageKey, WidthSchema);
      return stored === null ? null : clamp(stored);
    } catch (error) {
      console.error("Could not read persisted panel width.", error);
      return null;
    }
  };
  const [widthState, setWidthState] = useState(() => ({ storageKey, width: readWidth() }));
  if (widthState.storageKey !== storageKey) {
    setWidthState({ storageKey, width: readWidth() });
  }

  const clampedWidth = clamp(widthState.width ?? defaultWidth);
  const restoreWidth = useStableCallback((host: HTMLElement | null) => {
    host?.style.setProperty(RESIZABLE_WIDTH_PROPERTY, `${clampedWidth}px`);
  });

  const commitWidth = (nextStorageKey: string, nextWidth: number) => {
    // Resizing remains usable for this session when browser storage is unavailable.
    setWidthState({ storageKey: nextStorageKey, width: nextWidth });
    try {
      setLocalStorageItem(nextStorageKey, nextWidth, WidthSchema);
    } catch (error) {
      console.error("Could not persist panel width.", error);
    }
  };

  const drag = useResizeDrag<HTMLElement>((event) => {
    const host = event.currentTarget.parentElement;
    // Disable drag transitions through transition-property; the host renders transition-duration.
    host?.style.setProperty("transition-property", "none");
    // The drag commits to the key and width it started from, even if the panel
    // switches keys before the pointer is released.
    const startStorageKey = storageKey;
    const startWidth = clampedWidth;
    return {
      width: startWidth,
      edge,
      bounds: { min: minWidth, max: maxWidth },
      resize(nextWidth) {
        host?.style.setProperty(RESIZABLE_WIDTH_PROPERTY, `${nextWidth}px`);
        return nextWidth;
      },
      finish(finalWidth, moved) {
        if (moved) commitWidth(startStorageKey, finalWidth);
        else restoreWidth(host);
      },
      cleanup(committed) {
        host?.style.removeProperty("transition-property");
        if (!committed) host?.style.setProperty(RESIZABLE_WIDTH_PROPERTY, `${startWidth}px`);
      },
    };
  });

  // Bounds can change mid-drag (sidebar opens, window narrows), and the render
  // that carries them rewrites the committed width, so re-apply the live pointer position.
  const { refresh } = drag;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reapplies the live drag pointer position to the DOM before paint when the bounds change
  useLayoutEffect(() => refresh({ min: minWidth, max: maxWidth }), [refresh, minWidth, maxWidth]);

  const setWidth = (value: number) => commitWidth(storageKey, clamp(value));
  // The arrow pointing away from the edge the handle sits on grows the panel.
  const growKey = edge === "left" ? "ArrowLeft" : "ArrowRight";
  const shrinkKey = edge === "left" ? "ArrowRight" : "ArrowLeft";
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    let nextWidth: number;
    switch (event.key) {
      case growKey:
        nextWidth = clampedWidth + 16;
        break;
      case shrinkKey:
        nextWidth = clampedWidth - 16;
        break;
      case "Home":
        nextWidth = minWidth;
        break;
      case "End":
        nextWidth = maxWidth;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    setWidth(nextWidth);
  };

  return {
    width: clampedWidth,
    setWidth,
    handlers: {
      ref: drag.ref,
      onPointerDown: drag.onPointerDown,
      onPointerMove: drag.onPointerMove,
      onPointerUp: drag.onPointerUp,
      onPointerCancel: drag.onPointerCancel,
      onLostPointerCapture: drag.onLostPointerCapture,
      tabIndex: 0,
      "aria-valuenow": clampedWidth,
      "aria-valuemin": minWidth,
      "aria-valuemax": maxWidth,
      onKeyDown,
    },
  };
}
