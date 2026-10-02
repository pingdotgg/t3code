import * as Schema from "effect/Schema";
import { useCallback, type CSSProperties } from "react";

import { useLocalStorage } from "./useLocalStorage";

export const THREAD_WIDTH_STORAGE_KEY = "t3code:thread-width-expansion";
export const THREAD_WIDTH_STEP = 5;

/** Normalize stored input to a bounded expansion in five-percent steps. */
export function normalizeThreadWidth(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(0, Math.round(value / THREAD_WIDTH_STEP) * THREAD_WIDTH_STEP))
    : 0;
}

/** Expand the configured Appearance width toward the available chat pane width. */
export function threadWidthStyle(expansion: number): CSSProperties {
  // Percentages resolve against the chat pane, including when a right
  // panel takes space. w-full keeps narrow panes at their original width.
  const ratio = normalizeThreadWidth(expansion) / 100;
  return {
    "--thread-content-max-width":
      ratio === 0
        ? "var(--chat-max-width, 48rem)"
        : ratio === 1
          ? "100%"
          : `calc(var(--chat-max-width, 48rem) * ${1 - ratio} + 100% * ${ratio})`,
  } as CSSProperties;
}

/** Share a device-local width preference between the toolbar and chat layout. */
export function useThreadWidth() {
  const [stored, setStored] = useLocalStorage<unknown, unknown>(
    THREAD_WIDTH_STORAGE_KEY,
    0,
    Schema.Unknown,
  );
  const setExpansion = useCallback(
    (value: number) => setStored(normalizeThreadWidth(value)),
    [setStored],
  );
  return [normalizeThreadWidth(stored), setExpansion] as const;
}
