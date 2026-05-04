import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { SidebarInset } from "~/components/ui/sidebar";
import { parseDiffRouteSearch } from "./diffRouteSearch";
import { buildThreadRouteParams } from "./threadRoutes";
import {
  dragEventHasScopedThreadPayload,
  readScopedThreadRefFromDataTransfer,
} from "./threadSplitDnD";

const SPLIT_RATIO_STORAGE_KEY = "t3code:chat-thread-split-left-ratio:v1";

function clampSplitRatio(value: number): number {
  return Math.min(0.72, Math.max(0.28, value));
}

export function usePersistedChatSplitRatio(): readonly [number, (next: number) => void] {
  const [leftRatio, setLeftRatioState] = useState(0.5);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SPLIT_RATIO_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const n = Number.parseFloat(raw);
      if (Number.isFinite(n)) {
        setLeftRatioState(clampSplitRatio(n));
      }
    } catch {
      // Ignore localStorage failures.
    }
  }, []);
  const setLeftRatio = useCallback((next: number) => {
    const clamped = clampSplitRatio(next);
    setLeftRatioState(clamped);
    try {
      window.localStorage.setItem(SPLIT_RATIO_STORAGE_KEY, String(clamped));
    } catch {
      // Ignore quota failures.
    }
  }, []);
  return [leftRatio, setLeftRatio] as const;
}

function SplitGutter(props: { onResizeDelta: (deltaX: number, totalWidth: number) => void }) {
  const gutterRef = useRef<HTMLDivElement>(null);
  const { onResizeDelta } = props;
  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const row = gutterRef.current?.parentElement;
      if (!row) {
        return;
      }
      const totalWidth = row.clientWidth;
      const startX = event.clientX;
      const onMove = (moveEvent: PointerEvent) => {
        onResizeDelta(moveEvent.clientX - startX, totalWidth);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [onResizeDelta],
  );
  return (
    <div
      ref={gutterRef}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize split panes"
      className="w-px shrink-0 cursor-col-resize bg-border hover:bg-primary/40"
      onPointerDown={onPointerDown}
    />
  );
}

export function ThreadSplitRow(props: {
  leftRatio: number;
  onRatioDelta: (deltaFraction: number) => void;
  left: ReactNode;
  /** When null, only the left pane is shown at full width (no gutter). Keeps the same DOM ancestry as split mode so the primary pane does not remount when toggling split. */
  right: ReactNode | null;
}) {
  const { leftRatio, onRatioDelta, left, right } = props;
  const split = right !== null;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-row">
      <div
        className="flex min-h-0 min-w-0 flex-col"
        style={{ flex: split ? `${leftRatio} 1 0%` : "1 1 0%" }}
      >
        {left}
      </div>
      {split ? (
        <>
          <SplitGutter
            onResizeDelta={(deltaX, totalWidth) => {
              if (totalWidth <= 0) {
                return;
              }
              onRatioDelta(deltaX / totalWidth);
            }}
          />
          <div className="flex min-h-0 min-w-0 flex-col" style={{ flex: `${1 - leftRatio} 1 0%` }}>
            {right}
          </div>
        </>
      ) : null}
    </div>
  );
}

function mergeSearchForSplitUpdate(
  previous: Record<string, unknown>,
  splitRef: ScopedThreadRef,
): Record<string, unknown> {
  const parsed = parseDiffRouteSearch(previous);
  const next: Record<string, unknown> = { ...previous };
  next.splitEnvironmentId = splitRef.environmentId;
  next.splitThreadId = splitRef.threadId;
  if (parsed.diff === "1" && (parsed.diffThreadEnvironmentId || parsed.diffThreadId)) {
    delete next.diffThreadEnvironmentId;
    delete next.diffThreadId;
  }
  return next;
}

type ThreadRouteNavigate = ReturnType<typeof useNavigate>;

export function ChatThreadSplitDropInset(props: {
  pathThreadRef: ScopedThreadRef;
  splitThreadRef: ScopedThreadRef | null;
  dropRole: "primary" | "secondary";
  navigate: ThreadRouteNavigate;
  children: ReactNode;
}) {
  const { pathThreadRef, splitThreadRef, dropRole, navigate, children } = props;
  const dragDepthRef = useRef(0);
  const [highlight, setHighlight] = useState(false);

  const acceptDrop = useCallback(
    (dropped: ScopedThreadRef) => {
      if (scopedThreadKey(dropped) === scopedThreadKey(pathThreadRef)) {
        return;
      }
      if (
        dropRole === "primary" &&
        splitThreadRef &&
        scopedThreadKey(dropped) === scopedThreadKey(splitThreadRef)
      ) {
        return;
      }
      if (
        dropRole === "secondary" &&
        splitThreadRef &&
        scopedThreadKey(dropped) === scopedThreadKey(splitThreadRef)
      ) {
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(pathThreadRef),
        search: (previous) =>
          mergeSearchForSplitUpdate(previous as Record<string, unknown>, dropped),
      });
    },
    [dropRole, navigate, pathThreadRef, splitThreadRef],
  );

  const onDragEnter = useCallback((event: React.DragEvent) => {
    if (!dragEventHasScopedThreadPayload(event)) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current += 1;
    setHighlight(true);
  }, []);

  const onDragLeave = useCallback((event: React.DragEvent) => {
    if (!dragEventHasScopedThreadPayload(event)) {
      return;
    }
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setHighlight(false);
    }
  }, []);

  const onDragOver = useCallback((event: React.DragEvent) => {
    if (!dragEventHasScopedThreadPayload(event)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      dragDepthRef.current = 0;
      setHighlight(false);
      if (!dragEventHasScopedThreadPayload(event)) {
        return;
      }
      event.preventDefault();
      const dropped = readScopedThreadRefFromDataTransfer(event.dataTransfer);
      if (!dropped) {
        return;
      }
      acceptDrop(dropped);
    },
    [acceptDrop],
  );

  return (
    <SidebarInset
      className={`relative h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh ${
        highlight ? "ring-2 ring-inset ring-primary/50" : ""
      }`}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
      data-chat-split-drop={dropRole}
    >
      {children}
    </SidebarInset>
  );
}

export function resolveSplitThreadRefFromSearch(
  pathThreadRef: ScopedThreadRef,
  search: ReturnType<typeof parseDiffRouteSearch>,
): ScopedThreadRef | null {
  if (!search.splitEnvironmentId || !search.splitThreadId) {
    return null;
  }
  const splitRef = scopeThreadRef(search.splitEnvironmentId, search.splitThreadId);
  if (scopedThreadKey(splitRef) === scopedThreadKey(pathThreadRef)) {
    return null;
  }
  return splitRef;
}
