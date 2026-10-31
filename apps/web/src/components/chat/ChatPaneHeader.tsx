import { useRef, useState, type ReactNode, type Ref } from "react";

import { isElectron } from "../../env";
import { useLayoutPane } from "../../layout/layoutPaneContext";
import { observeResize } from "../../lib/observeResize";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { cn } from "../../lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { PaneNotch } from "../PaneNotch";

/**
 * A chat pane's top bar, shared by ChatView and the stand-in a pane shows
 * before its chat first renders (layout/ChatPaneStandIn), so the two line up
 * to the pixel. Children: the controls cluster and ChatHeader.
 */
export function ChatPaneHeader({
  ref,
  reserveNativeControlsInset,
  children,
}: {
  ref?: Ref<HTMLElement>;
  /** Electron's window controls take the trailing pane's top-right corner. */
  reserveNativeControlsInset: boolean;
  children: ReactNode;
}) {
  const { leadingEdge, trailingEdge } = useLayoutPane();
  return (
    <header
      ref={ref}
      {...workspaceAreaProps("tabs", 0.5, "Thread tabs")}
      data-chat-header
      data-pane-header
      className={chatPaneHeaderClassName({ leadingEdge, trailingEdge, reserveNativeControlsInset })}
    >
      {children}
    </header>
  );
}

/**
 * The chat pane header's box, for whatever draws one (ChatPaneHeader, the
 * overview's thumbnails), so their notches line up on every surface.
 */
export function chatPaneHeaderClassName({
  leadingEdge,
  trailingEdge,
  reserveNativeControlsInset,
}: {
  leadingEdge: boolean;
  trailingEdge: boolean;
  reserveNativeControlsInset: boolean;
}): string {
  return cn(
    // Keep tab menus above the timeline. Ease the collapsed-sidebar inset with the sidebar so the
    // tab moves with its pane.
    "relative z-10 bg-background md:pl-0 [[data-panel-animations=true]_&]:motion-safe:transition-[padding-left] [[data-panel-animations=true]_&]:motion-safe:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:motion-safe:ease-out",
    isElectron
      ? cn(
          "drag-region flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center px-3 sm:px-5",
          reserveNativeControlsInset &&
            trailingEdge &&
            "wco:pr-(--workspace-native-controls-inset)",
        )
      : "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center pl-(--workspace-gutter-start) pr-(--workspace-gutter-end)",
    // Only the pane in the window's top-left corner shares its row
    // with the collapsed sidebar's toggle and the traffic lights.
    leadingEdge && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
  );
}

/**
 * The header's top-right controls on the mirrored pane notch. Pass `measureRef` from
 * `useHeaderControlsInset` to learn the room it takes from the notch.
 */
export function ChatPaneHeaderControls({
  measureRef,
  local = false,
  marksHost = true,
  children,
}: {
  measureRef?: Ref<HTMLDivElement>;
  /** For controls that stay at this header's edge even in a single pane. */
  local?: boolean;
  marksHost?: boolean;
  children: ReactNode;
}) {
  const { split } = useLayoutPane();
  return (
    <div
      ref={measureRef}
      className={cn(
        "pointer-events-none z-50 flex h-[var(--workspace-topbar-height)] items-center gap-1 md:pe-(--workspace-pane-local-controls-right) [-webkit-app-region:no-drag]",
        // Several panes each carry their own cluster at their own top-right.
        split || local
          ? "absolute top-[var(--workspace-pane-local-controls-top)] right-[var(--workspace-pane-local-controls-right)] md:top-0 md:right-0"
          : "fixed top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] mr-px md:right-(--workspace-pane-inset) md:mr-0",
      )}
      data-workspace-titlebar-controls
    >
      <PaneNotch side="right" marksHost={marksHost}>
        <div className="pointer-events-auto flex h-full items-center gap-1.5">{children}</div>
      </PaneNotch>
    </div>
  );
}

/**
 * The header's floating controls change width with the pane (labels collapse
 * to icons), so the notch learns how much room they take: ChatHeader's
 * `trailingInset`, from the cluster `measure` is attached to (as its ref).
 */
export function useHeaderControlsInset(): [
  inset: number | null,
  measure: (node: HTMLDivElement | null) => void,
] {
  const [inset, setInset] = useState<number | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const [measure] = useState(() => (node: HTMLDivElement | null) => {
    stopRef.current?.();
    stopRef.current = null;
    if (!node) {
      setInset(null);
      return;
    }
    const update = () => {
      const header = node.closest<HTMLElement>("[data-chat-header]");
      if (!header || node.offsetWidth === 0) {
        setInset(null);
        return;
      }
      const headerRect = header.getBoundingClientRect();
      const paddingEnd = Number.parseFloat(getComputedStyle(header).paddingRight) || 0;
      const room = headerRect.right - paddingEnd - node.getBoundingClientRect().left + 8;
      setInset(Math.max(0, Math.ceil(room)));
    };
    // Measured as it mounts too: the observer's first size arrives a frame
    // late, and the title would truncate against the fallback room till then.
    update();
    stopRef.current = observeResize(node, update);
  });
  return [inset, measure];
}
