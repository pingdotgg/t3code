/**
 * Imperative half of "jump to transcript".
 *
 * The tracker popover lives in the chat header and the timeline owns the row
 * index, so the timeline publishes a handler through a ref rather than the
 * header reaching into a list it does not own. Nothing re-renders when the
 * handler is published, and the handler is torn down with the timeline.
 */

import type { LegendListRef } from "@legendapp/list/react";
import { useEffect, useRef, type RefObject } from "react";

import {
  AGENT_RUN_FLASH_DURATION_MS,
  AGENT_RUN_FLASH_MAX_FRAMES,
  agentRunRowSelector,
  findAgentRunRowIndex,
} from "./agentRunJump.logic.ts";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic.ts";

/** Returns false when the run has no transcript row (ambient, or not loaded). */
export type AgentRunJumpHandler = (taskId: string) => boolean;

export function useAgentRunJumpTarget(
  jumpRef: RefObject<AgentRunJumpHandler | null> | undefined,
  rows: ReadonlyArray<MessagesTimelineRow>,
  listRef: RefObject<LegendListRef | null>,
): void {
  // Read through a ref so publishing the handler does not depend on `rows`:
  // rebinding it on every timeline change would be pure churn.
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  useEffect(() => {
    if (!jumpRef) {
      return;
    }
    jumpRef.current = (taskId) => {
      const index = findAgentRunRowIndex(rowsRef.current, taskId);
      const list = listRef.current;
      if (index < 0 || !list) {
        return false;
      }
      void list.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
      flashAgentRunRow(list.getScrollableNode?.() ?? null, taskId);
      return true;
    };
    return () => {
      jumpRef.current = null;
    };
  }, [jumpRef, listRef]);
}

/**
 * The row is virtualized, so it may mount a few frames after the scroll starts.
 * Poll by animation frame until it appears, then flash it exactly once.
 */
function flashAgentRunRow(scrollNode: unknown, taskId: string): void {
  if (typeof requestAnimationFrame !== "function") {
    return;
  }
  const root = isQueryable(scrollNode) ? scrollNode : globalThis.document;
  if (!root) {
    return;
  }
  const selector = agentRunRowSelector(taskId);
  let framesLeft = AGENT_RUN_FLASH_MAX_FRAMES;
  const tick = () => {
    const element = root.querySelector(selector);
    if (element) {
      flashElement(element);
      return;
    }
    framesLeft -= 1;
    if (framesLeft > 0) {
      requestAnimationFrame(tick);
    }
  };
  requestAnimationFrame(tick);
}

function flashElement(element: Element): void {
  if (prefersReducedMotion() || typeof element.animate !== "function") {
    return;
  }
  element.animate(
    [
      { boxShadow: "0 0 0 0 transparent", borderRadius: "6px" },
      { boxShadow: "0 0 0 2px color-mix(in oklab, var(--ring) 70%, transparent)" },
      { boxShadow: "0 0 0 0 transparent" },
    ],
    { duration: AGENT_RUN_FLASH_DURATION_MS, easing: "ease-in-out" },
  );
}

function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function isQueryable(value: unknown): value is Element {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Element).querySelector === "function"
  );
}
