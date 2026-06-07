import { useEffect, useRef, useState } from "react";

import type { ResolvedKeybindingsConfig, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import { TerminalViewport } from "./ThreadTerminalDrawer";

/**
 * Renders a single terminal session filling its container, for use as the body
 * of a dock-slot tab. Sizing is owned by the surrounding panel; a
 * ResizeObserver bumps the resize epoch so the terminal refits when the panel
 * is resized.
 */
export function SingleTerminalView(props: {
  threadRef: ScopedThreadRef;
  threadId: ThreadId;
  terminalId: string;
  terminalLabel: string;
  cwd: string;
  worktreePath?: string | null;
  runtimeEnv?: Record<string, string>;
  active: boolean;
  focusRequestId: number;
  keybindings: ResolvedKeybindingsConfig;
  onSessionExited: () => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [resizeEpoch, setResizeEpoch] = useState(0);
  const [measuredHeight, setMeasuredHeight] = useState(0);

  useEffect(() => {
    if (!props.active) return;
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const nextHeight = Math.round(entry.contentRect.height);
      if (nextHeight > 0) {
        setMeasuredHeight(nextHeight);
      }
      setResizeEpoch((value) => value + 1);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [props.active]);

  return (
    <div ref={containerRef} className="h-full min-h-0 w-full p-1">
      <TerminalViewport
        threadRef={props.threadRef}
        threadId={props.threadId}
        terminalId={props.terminalId}
        terminalLabel={props.terminalLabel}
        cwd={props.cwd}
        {...(props.worktreePath !== undefined ? { worktreePath: props.worktreePath } : {})}
        {...(props.runtimeEnv ? { runtimeEnv: props.runtimeEnv } : {})}
        onSessionExited={props.onSessionExited}
        onAddTerminalContext={props.onAddTerminalContext}
        focusRequestId={props.focusRequestId}
        autoFocus={props.active}
        resizeEpoch={resizeEpoch}
        drawerHeight={measuredHeight}
        keybindings={props.keybindings}
      />
    </div>
  );
}
