import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  type PreviewPanelInlineSize,
  usePreviewPanelInlineSize,
} from "~/hooks/usePreviewPanelInlineSize";
import { RESIZABLE_WIDTH_PROPERTY } from "~/hooks/useResizableWidth";
import { cn } from "~/lib/utils";

import { RightPanelResizeHandle } from "./RightPanelResizeHandle";

export type PreviewPanelMode = "inline" | "sheet" | "sidebar" | "embedded";

interface PreviewPanelShellProps {
  mode: PreviewPanelMode;
  maximized?: boolean;
  inlineSize?: PreviewPanelInlineSize;
  open?: boolean;
  /** Use a distinct key per surface to keep remembered widths independent. */
  widthStorageKey?: string;
  defaultWidth?: number;
  children: ReactNode;
}

export function PreviewPanelShell(props: PreviewPanelShellProps) {
  if (props.inlineSize) {
    return <PreviewPanelShellFrame {...props} inlineSize={props.inlineSize} />;
  }

  return <ResizablePreviewPanelShell {...props} />;
}

function ResizablePreviewPanelShell(props: PreviewPanelShellProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const inlineSize = usePreviewPanelInlineSize(hostRef, {
    enabled: props.mode === "inline" && !props.maximized,
    widthStorageKey: props.widthStorageKey,
    defaultWidth: props.defaultWidth,
  });
  return <PreviewPanelShellFrame {...props} inlineSize={inlineSize} hostRef={hostRef} />;
}

function PreviewPanelShellFrame(
  props: PreviewPanelShellProps & {
    inlineSize: PreviewPanelInlineSize;
    hostRef?: RefObject<HTMLDivElement | null>;
  },
) {
  const isInline = props.mode === "inline";
  const collapsible = isInline && props.open !== undefined;
  const open = props.open ?? true;
  const maximized = props.maximized ?? false;
  const localHostRef = useRef<HTMLDivElement | null>(null);
  const hostRef = props.hostRef ?? localHostRef;
  const returnedFocus = useRef(false);
  const { width, handlers } = props.inlineSize;
  // Suppress transitions before commit so resize/maximize changes never start width transitions.
  const [layoutTransition, setLayoutTransition] = useState(() => ({
    open,
    width,
    maximized,
    suppressed: false,
  }));
  if (
    layoutTransition.open !== open ||
    layoutTransition.width !== width ||
    layoutTransition.maximized !== maximized
  ) {
    setLayoutTransition({
      open,
      width,
      maximized,
      suppressed:
        collapsible &&
        layoutTransition.open === open &&
        (layoutTransition.width !== width || layoutTransition.maximized !== maximized),
    });
  }
  const suppressWidthTransition = layoutTransition.suppressed;
  useLayoutEffect(() => {
    if (!suppressWidthTransition) return;
    let restoreFrame = 0;
    const paintFrame = window.requestAnimationFrame(() => {
      restoreFrame = window.requestAnimationFrame(() => {
        setLayoutTransition((current) => ({ ...current, suppressed: false }));
      });
    });
    return () => {
      window.cancelAnimationFrame(paintFrame);
      window.cancelAnimationFrame(restoreFrame);
    };
  }, [suppressWidthTransition]);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !collapsible) return;
    return () => {
      if (!host.contains(host.ownerDocument.activeElement) && !returnedFocus.current) return;
      // Unmount moves the toggle; restore focus at its committed location if removal sent focus to body.
      queueMicrotask(() => {
        if (host.ownerDocument.activeElement === host.ownerDocument.body) {
          host.ownerDocument.querySelector<HTMLButtonElement>("[data-right-panel-toggle]")?.focus();
        }
      });
    };
  }, [collapsible, hostRef]);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const collapsed = collapsible && !open;
    if (!collapsed) returnedFocus.current = false;
    // Move focus before making its current owner inert, while the toggle is reachable.
    if (collapsed && host.contains(host.ownerDocument.activeElement)) {
      const toggle = host.ownerDocument.querySelector<HTMLButtonElement>(
        "[data-right-panel-toggle]",
      );
      toggle?.focus();
      returnedFocus.current = toggle !== null && host.ownerDocument.activeElement === toggle;
    }
    host.toggleAttribute("inert", collapsed);
  }, [collapsible, open, hostRef]);
  return (
    <div
      ref={hostRef}
      className={cn(
        "relative flex h-full min-h-0 min-w-0 max-w-full flex-col self-stretch bg-background",
        isInline
          ? maximized
            ? // Maximizing meets the sidebar border or window edge; omit the duplicate border.
              "flex-1"
            : "shrink-0 border-l border-border"
          : "w-full",
        collapsible &&
          "[[data-panel-animations=true]_&]:transition-[width] [[data-panel-animations=true]_&]:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:ease-out",
        collapsible && open && "[[data-panel-animations=true]_&]:starting:w-0!",
        collapsible && !open && "pointer-events-none",
      )}
      style={
        isInline
          ? ({
              [RESIZABLE_WIDTH_PROPERTY]: `${width}px`,
              width: maximized
                ? "100%"
                : collapsible && !open
                  ? "0px"
                  : `var(${RESIZABLE_WIDTH_PROPERTY})`,
              transitionDuration: suppressWidthTransition ? "0ms" : undefined,
            } as CSSProperties)
          : undefined
      }
      data-preview-panel-mode={props.mode}
      data-preview-panel-maximized={maximized ? "true" : "false"}
    >
      {isInline && !maximized ? <RightPanelResizeHandle handlers={handlers} /> : null}
      <div className={cn("h-full min-h-0 w-full", collapsible && "overflow-clip")}>
        <div
          className="flex h-full min-h-0 min-w-0 flex-col"
          style={
            collapsible && !maximized
              ? { width: `calc(var(${RESIZABLE_WIDTH_PROPERTY}) - 1px)` }
              : undefined
          }
        >
          {props.children}
        </div>
      </div>
    </div>
  );
}
