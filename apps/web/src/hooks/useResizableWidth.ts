import * as Schema from "effect/Schema";
import { type PointerEvent as ReactPointerEvent, useLayoutEffect, useState } from "react";

import { useLocalStorage, writeLocalStorageValue } from "./useLocalStorage";
import { useResizeDrag } from "./useResizeDrag";

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
}

/** Persist on drag end to avoid a storage write on every animation frame. */
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

  // Panels that share a key follow each other's drags, in this tab and in others.
  const [storedWidth] = useLocalStorage(storageKey, defaultWidth, WidthSchema);
  // Resizing remains usable for this session when browser storage is unavailable.
  const [unsaved, setUnsaved] = useState<{
    readonly storageKey: string;
    readonly storedWidth: number;
    readonly width: number;
  } | null>(null);
  const clampedWidth = clamp(
    unsaved?.storageKey === storageKey && unsaved.storedWidth === storedWidth
      ? unsaved.width
      : storedWidth,
  );

  const commitWidth = (nextStorageKey: string, nextWidth: number) => {
    const saved = writeLocalStorageValue(nextStorageKey, nextWidth, defaultWidth, WidthSchema);
    setUnsaved(saved ? null : { storageKey: nextStorageKey, storedWidth, width: nextWidth });
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
      finish(finalWidth) {
        commitWidth(startStorageKey, finalWidth);
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

  return {
    width: clampedWidth,
    setWidth: (value) => commitWidth(storageKey, clamp(value)),
    handlers: {
      ref: drag.ref,
      onPointerDown: drag.onPointerDown,
      onPointerMove: drag.onPointerMove,
      onPointerUp: drag.onPointerUp,
      onPointerCancel: drag.onPointerCancel,
      onLostPointerCapture: drag.onLostPointerCapture,
    },
  };
}
