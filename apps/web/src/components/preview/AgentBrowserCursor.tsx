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
  const scale = zoomFactor * (content?.scale ?? 1);
  return (
    <AgentCursorMark
      phase={event.phase}
      sequence={event.sequence}
      left={event.x * scale + (content?.x ?? 0) - (content?.scrollLeft ?? 0)}
      top={event.y * scale + (content?.y ?? 0) - (content?.scrollTop ?? 0)}
      controller={controller}
    />
  );
}

/** The agent's pointer at a surface position; it fades once the agent stops acting. */
export function AgentCursorMark(props: {
  readonly phase: "move" | "click";
  readonly sequence: number;
  readonly left: number;
  readonly top: number;
  readonly controller: BrowserController;
}) {
  const { phase, sequence, left, top, controller } = props;
  const [inactiveSequence, setInactiveSequence] = useState<number | null>(null);
  const active = inactiveSequence !== sequence;

  useEffect(() => {
    const timeout = window.setTimeout(() => setInactiveSequence(sequence), CURSOR_ACTIVE_MS);
    return () => window.clearTimeout(timeout);
  }, [sequence]);

  return (
    <div
      className="pointer-events-none absolute left-0 top-0 z-40 transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none"
      style={{
        opacity: agentBrowserCursorOpacity(active, controller),
        transform: `translate3d(${left}px, ${top}px, 0)`,
      }}
      aria-hidden="true"
      data-agent-browser-cursor
    >
      {phase === "click" ? (
        <span
          key={sequence}
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
