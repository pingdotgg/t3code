import {
  type CSSProperties,
  type FocusEvent,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  type PreviewPanelInlineSize,
  usePreviewPanelInlineSize,
} from "~/hooks/usePreviewPanelInlineSize";
import { RESIZABLE_WIDTH_PROPERTY } from "~/hooks/useResizableWidth";
import { canReturnFocusTo, workspaceAreaProps } from "../../lib/workspaceFocus";
import { cn } from "~/lib/utils";

import { RightPanelResizeHandle } from "./RightPanelResizeHandle";

export type PreviewPanelMode = "inline" | "sheet" | "sidebar" | "embedded";

interface PreviewPanelShellProps {
  workspaceArea?: boolean;
  workspaceFocusKey?: string;
  workspaceLabel?: string;
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
  const inlineSize = usePreviewPanelInlineSize({
    enabled: props.mode === "inline" && !props.maximized,
    widthStorageKey: props.widthStorageKey,
    defaultWidth: props.defaultWidth,
  });
  return <PreviewPanelShellFrame {...props} inlineSize={inlineSize} />;
}

// Prefers the element focus entered the panel from, falling back to the panel toggle.
function returnFocus(host: HTMLElement, origin: HTMLElement | null) {
  const { ownerDocument } = host;
  // focus() is a no-op on a disabled origin, so activeElement says whether it took.
  if (origin?.isConnected && !host.contains(origin) && canReturnFocusTo(origin)) {
    origin.focus({ preventScroll: true });
    if (ownerDocument.activeElement === origin) return true;
  }
  const toggle = ownerDocument.querySelector<HTMLButtonElement>("[data-right-panel-toggle]");
  toggle?.focus();
  return toggle !== null && ownerDocument.activeElement === toggle;
}

function PreviewPanelShellFrame(
  props: PreviewPanelShellProps & { inlineSize: PreviewPanelInlineSize },
) {
  const panelArea = workspaceAreaProps("panel", 4, props.workspaceLabel ?? "Workspace panel");
  const isInline = props.mode === "inline";
  const collapsible = isInline && props.open !== undefined;
  const open = props.open ?? true;
  const maximized = props.maximized ?? false;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const returnedFocus = useRef(false);
  const focusOrigin = useRef<HTMLElement | null>(null);
  const lastBlurred = useRef<EventTarget | null>(null);
  const { width, handlers, observeRow } = props.inlineSize;
  // Width animates only for an open or close. Any other width change disables
  // the transition in the same commit that changes the width, so the browser
  // never starts one; the next open or close re-enables it in its own commit,
  // so nothing waits for a paint.
  const [widthTransition, setWidthTransition] = useState(() => ({
    open,
    width,
    maximized,
    enabled: true,
  }));
  if (
    widthTransition.open !== open ||
    widthTransition.width !== width ||
    widthTransition.maximized !== maximized
  ) {
    setWidthTransition({
      open,
      width,
      maximized,
      enabled: widthTransition.open !== open,
    });
  }
  const suppressWidthTransition = collapsible && !widthTransition.enabled;
  const attachHost = (host: HTMLDivElement) => {
    hostRef.current = host;
    const stopObservingRow = observeRow(host);
    return () => {
      hostRef.current = null;
      stopObservingRow();
    };
  };
  // React focus events, unlike a listener added in attachHost, also see content that focuses
  // itself while mounting (a terminal does, from a ref that attaches before the host's).
  // Focus moving within the panel, portalled menus included, first blurs an element of it.
  const rememberFocusOrigin = (event: FocusEvent<HTMLDivElement>) => {
    const from = event.relatedTarget;
    if (from === null || from === lastBlurred.current) return;
    focusOrigin.current = from instanceof HTMLElement ? from : null;
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- on unmount, returns DOM focus to where it came from if removal dropped it on the body
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !collapsible) return;
    return () => {
      if (!host.contains(host.ownerDocument.activeElement) && !returnedFocus.current) return;
      const origin = focusOrigin.current;
      // Unmount moves the toggle; restore focus at its committed location if removal sent focus to body.
      queueMicrotask(() => {
        if (host.ownerDocument.activeElement === host.ownerDocument.body) {
          returnFocus(host, origin);
        }
      });
    };
  }, [collapsible, hostRef]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves focus out of the host and sets inert on it before a collapse paints
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const collapsed = collapsible && !open;
    if (!collapsed) returnedFocus.current = false;
    // Move focus before making its current owner inert, while the toggle is reachable.
    if (collapsed && host.contains(host.ownerDocument.activeElement)) {
      returnedFocus.current = returnFocus(host, focusOrigin.current);
    }
    // An origin belongs to one open; the next one records its own.
    if (collapsed) focusOrigin.current = null;
    host.toggleAttribute("inert", collapsed);
  }, [collapsible, open, hostRef]);
  return (
    <div
      ref={attachHost}
      onFocus={rememberFocusOrigin}
      onBlur={(event) => {
        lastBlurred.current = event.target;
      }}
      {...(props.workspaceArea ? panelArea : {})}
      data-workspace-focus-key={props.workspaceFocusKey}
      data-workspace-unavailable={collapsible && !open ? "true" : undefined}
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
      {/* Content stays pinned to the right edge, so closing uncovers the chat
          instead of sliding the tab bar under the title bar controls. */}
      <div
        className={cn(
          "h-full min-h-0 w-full",
          collapsible && "overflow-clip",
          collapsible && !maximized && "flex justify-end",
        )}
      >
        <div
          className={cn(
            "flex h-full min-h-0 min-w-0 flex-col",
            collapsible && !maximized && "shrink-0",
          )}
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
