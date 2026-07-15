"use client";

import type { DesktopPreviewPointerEvent } from "@t3tools/contracts";
import { MousePointer2 } from "lucide-react";
import { useEffect, useState } from "react";

import { useBrowserPointerStore } from "~/browser/browserPointerStore";
import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";

import { agentBrowserCursorOpacity, type BrowserController } from "./agentBrowserCursorLogic";

const CURSOR_ACTIVE_MS = 700;

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
    <AgentBrowserCursorEvent
      key={event.sequence}
      event={event}
      content={content}
      zoomFactor={zoomFactor}
      controller={controller}
    />
  );
}

function AgentBrowserCursorEvent(props: {
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

  useEffect(() => {
    const timeout = window.setTimeout(() => setActive(false), CURSOR_ACTIVE_MS);
    return () => window.clearTimeout(timeout);
  }, []);

  return (
    <div
      className="pointer-events-none absolute left-0 top-0 z-40 transition-[transform,opacity] duration-150 ease-out motion-reduce:transition-none"
      style={{
        opacity: agentBrowserCursorOpacity(active, controller),
        transform: `translate3d(${event.x * zoomFactor * (content?.scale ?? 1) + (content?.x ?? 0) - (content?.scrollLeft ?? 0)}px, ${event.y * zoomFactor * (content?.scale ?? 1) + (content?.y ?? 0) - (content?.scrollTop ?? 0)}px, 0)`,
      }}
      aria-hidden="true"
      data-agent-browser-cursor
    >
      {event.phase === "click" ? (
        <span
          key={event.sequence}
          className="absolute left-0.5 top-0.5 size-4 animate-status-ping rounded-full bg-primary/25 motion-reduce:animate-none"
        />
      ) : null}
      <MousePointer2
        className="relative size-5 -translate-x-0.5 -translate-y-0.5 fill-background text-primary drop-shadow-sm"
        strokeWidth={2}
      />
    </div>
  );
}
