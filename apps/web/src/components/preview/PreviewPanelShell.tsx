import { type CSSProperties, type ReactNode, useLayoutEffect, useRef, useState } from "react";

import { returnKeyboardToFocusedPane } from "~/layout/layoutPaneContext";
import {
  type PreviewPanelInlineSize,
  usePreviewPanelInlineSize,
} from "~/hooks/usePreviewPanelInlineSize";
import { RESIZABLE_WIDTH_PROPERTY } from "~/hooks/useResizableWidth";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
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
  /**
   * Inline only: the panel is its own inset pane, 8px of window chrome from the pane beside
   * it (the layout's gap), with the resize handle in that gap. Below md panes are full-bleed.
   */
  pane?: boolean;
  children: ReactNode;
}

function returnPanelFocus(scope: Document | HTMLElement): boolean {
  const target = scope.querySelector<HTMLElement>(
    '[data-right-panel-toggle], button[data-layout-coach="tab"], button[data-layout-coach="new-tab"]',
  );
  if (!target) return returnKeyboardToFocusedPane();
  target.focus({ preventScroll: true });
  return target.ownerDocument.activeElement === target;
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

function PreviewPanelShellFrame(
  props: PreviewPanelShellProps & { inlineSize: PreviewPanelInlineSize },
) {
  const panelArea = workspaceAreaProps("panel", 4, props.workspaceLabel ?? "Workspace panel");
  const isInline = props.mode === "inline";
  const pane = isInline && props.pane === true;
  const collapsible = isInline && props.open !== undefined;
  const open = props.open ?? true;
  const maximized = props.maximized ?? false;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const returnedFocus = useRef(false);
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- on unmount, returns DOM focus to the panel toggle if removal dropped it on the body
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !collapsible) return;
    const focusScope = host.closest<HTMLElement>("[data-layout-pane-id]") ?? host.ownerDocument;
    return () => {
      if (!host.contains(host.ownerDocument.activeElement) && !returnedFocus.current) return;
      // Capture the pane before unmount; restore focus only if removal sent it to body.
      queueMicrotask(() => {
        if (host.ownerDocument.activeElement === host.ownerDocument.body) {
          returnPanelFocus(focusScope);
        }
      });
    };
  }, [collapsible, hostRef]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves focus to the toggle and sets inert on the host DOM node before a collapse paints
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const collapsed = collapsible && !open;
    if (!collapsed) returnedFocus.current = false;
    // Move focus before making its current owner inert, using its owning pane.
    if (collapsed && host.contains(host.ownerDocument.activeElement)) {
      const focusScope = host.closest<HTMLElement>("[data-layout-pane-id]") ?? host.ownerDocument;
      returnedFocus.current = returnPanelFocus(focusScope);
    }
    host.toggleAttribute("inert", collapsed);
  }, [collapsible, open, hostRef]);
  return (
    <div
      ref={attachHost}
      {...(props.workspaceArea ? panelArea : {})}
      data-workspace-focus-key={props.workspaceFocusKey}
      data-workspace-unavailable={collapsible && !open ? "true" : undefined}
      className={cn(
        "relative flex h-full min-h-0 min-w-0 max-w-full flex-col self-stretch",
        pane
          ? cn("[--preview-panel-gap:0px]", open && "md:ps-2 md:[--preview-panel-gap:0.5rem]")
          : // A sheet shows its popover surface, the lift the narrow sidebar sheet has.
            cn("[--preview-panel-gap:1px]", props.mode !== "sheet" && "bg-background"),
        isInline ? (maximized ? "flex-1" : "shrink-0") : "w-full",
        isInline && !pane && !maximized && "border-l border-border",
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
      {isInline && !maximized ? (
        <RightPanelResizeHandle handlers={handlers} {...(pane ? { className: "md:left-0" } : {})} />
      ) : null}
      <div
        data-pane-notch-host={pane ? "" : undefined}
        className={cn(
          "h-full min-h-0 w-full",
          collapsible && "overflow-clip",
          collapsible && !maximized && "flex justify-end",
          pane && "overflow-hidden bg-background surface-grain md:rounded-pane",
        )}
      >
        <div
          className={cn(
            "flex h-full min-h-0 min-w-0 flex-col",
            collapsible && !maximized && "shrink-0",
          )}
          style={
            collapsible && !maximized
              ? { width: `calc(var(${RESIZABLE_WIDTH_PROPERTY}) - var(--preview-panel-gap))` }
              : undefined
          }
        >
          {props.children}
        </div>
      </div>
    </div>
  );
}
