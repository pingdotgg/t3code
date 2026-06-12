"use client";

import { MousePointer2 } from "lucide-react";
import { useEffect, useState } from "react";

import { useBrowserPointerStore } from "~/browser/browserPointerStore";

import { agentBrowserCursorOpacity, type BrowserController } from "./agentBrowserCursorLogic";

const CURSOR_ACTIVE_MS = 700;

export function AgentBrowserCursor(props: {
  readonly tabId: string;
  readonly zoomFactor: number;
  readonly controller: BrowserController;
}) {
  const { tabId, zoomFactor, controller } = props;
  const event = useBrowserPointerStore((state) => state.byTabId[tabId] ?? null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!event) return;
    setActive(true);
    const timeout = window.setTimeout(() => setActive(false), CURSOR_ACTIVE_MS);
    return () => window.clearTimeout(timeout);
  }, [event]);

  if (!event) return null;

  return (
    <div
      className="pointer-events-none absolute left-0 top-0 z-40 transition-[transform,opacity] duration-150 ease-out motion-reduce:transition-none"
      style={{
        opacity: agentBrowserCursorOpacity(active, controller),
        transform: `translate3d(${event.x * zoomFactor}px, ${event.y * zoomFactor}px, 0)`,
      }}
      aria-hidden="true"
      data-agent-browser-cursor
    >
      {event.phase === "click" ? (
        <span
          key={event.sequence}
          className="absolute left-0.5 top-0.5 size-4 animate-ping rounded-full bg-primary/25 motion-reduce:animate-none"
        />
      ) : null}
      <MousePointer2
        className="relative size-5 -translate-x-0.5 -translate-y-0.5 fill-background text-primary drop-shadow-sm"
        strokeWidth={2}
      />
    </div>
  );
}
