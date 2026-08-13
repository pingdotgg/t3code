"use client";

import type { DesktopPreviewPointerEvent } from "@t3tools/contracts";
import { MousePointer2 } from "lucide-react";
import { useEffect, useState } from "react";

import { useBrowserPointerStore } from "~/browser/browserPointerStore";
import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";

import {
  agentBrowserCursorLabel,
  agentBrowserCursorOpacity,
  type BrowserController,
} from "./agentBrowserCursorLogic";

const CURSOR_ACTIVE_MS = 1400;

export function AgentBrowserCursor(props: {
  readonly tabId: string;
  readonly zoomFactor: number;
  readonly controller: BrowserController;
}) {
  const { tabId, zoomFactor, controller } = props;
  const event = useBrowserPointerStore((state) => state.byTabId[tabId] ?? null);
  const content = useBrowserSurfaceStore((state) => state.byTabId[tabId]?.content ?? null);

  if (!event) return null;

  return (
    <AgentBrowserCursorMark
      event={event}
      content={content}
      zoomFactor={zoomFactor}
      controller={controller}
    />
  );
}

function AgentBrowserCursorMark(props: {
  readonly event: DesktopPreviewPointerEvent;
  readonly content: {
    readonly x: number;
    readonly y: number;
    readonly scale: number;
    readonly scrollLeft: number;
    readonly scrollTop: number;
  } | null;
  readonly zoomFactor: number;
  readonly controller: BrowserController;
}) {
  const { event, content, zoomFactor, controller } = props;
  const [active, setActive] = useState(true);
  const [clickSequence, setClickSequence] = useState<number | null>(
    event.phase === "click" ? event.sequence : null,
  );

  useEffect(() => {
    setActive(true);
    const timeout = window.setTimeout(() => setActive(false), CURSOR_ACTIVE_MS);
    return () => window.clearTimeout(timeout);
  }, [event.sequence]);

  useEffect(() => {
    if (event.phase === "click") {
      setClickSequence(event.sequence);
    }
  }, [event.phase, event.sequence]);

  const label = agentBrowserCursorLabel(event.phase, active);

  return (
    <div
      className="pointer-events-none absolute top-0 left-0 z-40 transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none"
      style={{
        opacity: agentBrowserCursorOpacity(active, controller),
        transform: `translate3d(${event.x * zoomFactor * (content?.scale ?? 1) + (content?.x ?? 0) - (content?.scrollLeft ?? 0)}px, ${event.y * zoomFactor * (content?.scale ?? 1) + (content?.y ?? 0) - (content?.scrollTop ?? 0)}px, 0)`,
      }}
      aria-hidden="true"
      data-agent-browser-cursor
    >
      {clickSequence !== null ? (
        <span
          key={clickSequence}
          className="absolute top-0.5 left-0.5 size-5 rounded-full bg-primary/30 motion-reduce:hidden"
          style={{ animation: "status-ping 0.55s ease-out 1 forwards" }}
        />
      ) : null}
      <MousePointer2
        className="relative size-5 -translate-x-0.5 -translate-y-0.5 fill-background text-primary drop-shadow-sm"
        strokeWidth={2}
      />
      {label ? (
        <span className="absolute top-4 left-3.5 rounded-sm bg-primary px-1 py-px font-sans text-[10px] font-medium text-primary-foreground shadow-sm">
          {label}
        </span>
      ) : null}
    </div>
  );
}
