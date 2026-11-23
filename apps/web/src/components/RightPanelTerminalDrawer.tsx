import type { ScopedThreadRef } from "@t3tools/contracts";
import { getTerminalLabel } from "@t3tools/shared/terminalLabelsCopy";
import { msg, T, useGT, useMessages } from "gt-react";
import {
  ChevronDown,
  ChevronRight,
  Maximize2,
  Minimize2,
  Plus,
  TerminalSquare,
} from "lucide-react";
import { memo, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";

import { Button } from "~/components/ui/button";
import { PanelTabCloseButton } from "~/components/ui/panel-tab-close-button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { workspaceAreaProps } from "~/lib/workspaceFocus";
import type { RightPanelSurface, TerminalPanelSurface } from "~/rightPanelStore";
import { useKnownTerminalSessions } from "~/state/terminalSessions";

import type { TerminalBodyHost } from "./terminalBodyHosts";
import {
  clampTerminalDrawerHeight,
  TERMINAL_DRAWER_COLLAPSED_HEIGHT,
  TERMINAL_DRAWER_MIN_HEIGHT,
  terminalDrawerStatus,
  type TerminalDrawerStatus,
} from "./RightPanelTabs.logic";

export interface RightPanelTerminalDrawerProps {
  threadRef: ScopedThreadRef;
  surfaces: readonly TerminalPanelSurface[];
  activeSurfaceId: string | null;
  open: boolean;
  height: number;
  maximized: boolean;
  terminalAvailable: boolean;
  /** Without operate access a close cannot end the session, so the server would list it again. */
  terminalClosable: boolean;
  terminalLabelsById: ReadonlyMap<string, string>;
  /** The thread's terminals, rendered elsewhere so they outlive this drawer. */
  bodyHost: TerminalBodyHost | null;
  onToggleOpen: () => void;
  onHeightCommit: (height: number) => void;
  onToggleMaximized: () => void;
  onActivateSurface: (surfaceId: string) => void;
  onCloseSurface: (surface: RightPanelSurface) => void;
  onNewTerminal: () => void;
}

const HEIGHT_PROPERTY = "--right-panel-terminal-height";

const STATUS_LABELS = {
  running: msg("running", { $context: "a terminal command is still running" }),
  ok: msg("ok", { $context: "a terminal command exited successfully" }),
  failed: msg("failed", { $context: "a terminal command exited with an error" }),
} as const satisfies Record<TerminalDrawerStatus, unknown>;

/** Subscribes to terminal metadata alone, so output never re-renders the drawer or the tool. */
const TerminalDrawerStatusText = memo(function TerminalDrawerStatusText(props: {
  threadRef: ScopedThreadRef;
  terminalId: string;
}) {
  const messages = useMessages();
  const sessions = useKnownTerminalSessions({
    environmentId: props.threadRef.environmentId,
    threadId: props.threadRef.threadId,
  });
  const summary =
    sessions?.find((session) => session.target.terminalId === props.terminalId)?.state.summary ??
    null;
  const status = terminalDrawerStatus(summary);
  if (status === null) return null;
  return (
    <span
      data-terminal-drawer-status={status}
      className={cn(
        "flex shrink-0 items-center gap-1",
        status === "failed" ? "text-destructive-foreground" : "text-muted-foreground",
      )}
    >
      {status === "running" ? (
        <span aria-hidden className="size-1.5 rounded-full bg-primary" />
      ) : null}
      {messages(STATUS_LABELS[status])}
    </span>
  );
});

function terminalLabel(labels: ReadonlyMap<string, string>, terminalId: string) {
  return labels.get(terminalId) ?? getTerminalLabel(terminalId);
}

export const RightPanelTerminalDrawer = memo(function RightPanelTerminalDrawer(
  props: RightPanelTerminalDrawerProps,
) {
  const gt = useGT();
  const drawerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
    containerHeight: number;
    height: number;
  } | null>(null);
  const bodySlotRef = useRef<HTMLDivElement>(null);
  const { bodyHost } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves the thread's terminal host element into this drawer and back out, so the terminals never remount
  useLayoutEffect(() => {
    const slot = bodySlotRef.current;
    if (!slot || !bodyHost) return;
    bodyHost.place(slot);
    return () => {
      if (bodyHost.element.parentElement === slot) bodyHost.park();
    };
  }, [bodyHost]);

  const activeSurface =
    props.surfaces.find((surface) => surface.id === props.activeSurfaceId) ??
    props.surfaces[0] ??
    null;
  const activeLabel = activeSurface
    ? terminalLabel(props.terminalLabelsById, activeSurface.activeTerminalId)
    : null;

  const onResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drawer = drawerRef.current;
    if (!drawer || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startHeight = drawer.getBoundingClientRect().height;
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight,
      containerHeight: drawer.parentElement?.getBoundingClientRect().height ?? startHeight,
      height: startHeight,
    };
  };
  const onResizePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.height = clampTerminalDrawerHeight(
      drag.startHeight + (drag.startY - event.clientY),
      drag.containerHeight,
    );
    drawerRef.current?.style.setProperty(HEIGHT_PROPERTY, `${drag.height}px`);
  };
  const onResizePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    drawerRef.current?.style.removeProperty(HEIGHT_PROPERTY);
    if (drag.height !== drag.startHeight) props.onHeightCommit(drag.height);
  };

  const terminalArea = props.open ? workspaceAreaProps("terminal", 5, gt("Terminal")) : {};

  return (
    <div
      ref={drawerRef}
      {...terminalArea}
      data-right-panel-terminal-drawer={props.open ? "open" : "closed"}
      data-maximized={props.open && props.maximized ? "true" : undefined}
      className={cn(
        "relative flex min-h-0 shrink-0 flex-col border-t border-border/80 bg-background",
        props.open && props.maximized && "flex-1",
      )}
      style={
        props.open && !props.maximized
          ? {
              height: `var(${HEIGHT_PROPERTY}, ${props.height}px)`,
              minHeight: TERMINAL_DRAWER_MIN_HEIGHT,
              maxHeight: `max(${TERMINAL_DRAWER_MIN_HEIGHT}px, calc(100% - 120px))`,
            }
          : undefined
      }
    >
      {props.open && !props.maximized ? (
        <div
          aria-hidden
          data-right-panel-terminal-resize
          className="absolute inset-x-0 -top-0.5 z-20 h-1.5 cursor-row-resize touch-none any-pointer-coarse:h-4"
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerEnd}
          onPointerCancel={onResizePointerEnd}
          onLostPointerCapture={onResizePointerEnd}
        />
      ) : null}
      {props.open ? (
        <div className="flex h-8 shrink-0 items-center gap-1 px-1.5" data-right-panel-terminal-tabs>
          <div role="tablist" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
            {props.surfaces.map((surface) => {
              const label = terminalLabel(props.terminalLabelsById, surface.activeTerminalId);
              const active = surface.id === activeSurface?.id;
              return (
                <div
                  key={surface.id}
                  role="tab"
                  aria-selected={active}
                  className={cn(
                    "group/tab flex h-6 max-w-36 shrink-0 items-center gap-0.5 rounded-md pr-2 pl-1.5 text-xs",
                    active
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  {props.terminalClosable ? (
                    <PanelTabCloseButton
                      label={gt("Close {title}", { title: label })}
                      onClick={() => props.onCloseSurface(surface)}
                    >
                      <TerminalSquare className="size-3" />
                    </PanelTabCloseButton>
                  ) : (
                    <TerminalSquare aria-hidden className="size-3 shrink-0" />
                  )}
                  <button
                    type="button"
                    className="flex min-w-0 cursor-pointer items-center"
                    onClick={() => props.onActivateSurface(surface.id)}
                  >
                    <span className="truncate">{label}</span>
                  </button>
                </div>
              );
            })}
            <DrawerIconButton
              label={gt("New terminal")}
              disabled={!props.terminalAvailable}
              onClick={props.onNewTerminal}
            >
              <Plus />
            </DrawerIconButton>
          </div>
          <DrawerIconButton
            label={props.maximized ? gt("Restore terminal") : gt("Maximize terminal")}
            onClick={props.onToggleMaximized}
          >
            {props.maximized ? <Minimize2 /> : <Maximize2 />}
          </DrawerIconButton>
          <DrawerIconButton label={gt("Collapse terminal")} onClick={props.onToggleOpen}>
            <ChevronDown />
          </DrawerIconButton>
        </div>
      ) : (
        <button
          type="button"
          data-right-panel-terminal-collapsed
          onClick={props.onToggleOpen}
          style={{ height: TERMINAL_DRAWER_COLLAPSED_HEIGHT }}
          className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 px-2 text-left text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        >
          <ChevronRight className="size-3.5 shrink-0" />
          <span className="shrink-0 font-medium text-foreground">
            <T>Terminal</T>
          </span>
          {activeLabel !== null && activeSurface ? (
            <>
              <span aria-hidden>·</span>
              <span className="min-w-0 truncate">{activeLabel}</span>
              <TerminalDrawerStatusText
                threadRef={props.threadRef}
                terminalId={activeSurface.activeTerminalId}
              />
            </>
          ) : null}
        </button>
      )}
      {/* One position for the body, so collapsing hides the terminal without remounting it. */}
      <div
        className={cn("flex min-h-0 flex-1 flex-col", !props.open && "hidden")}
        data-right-panel-terminal-body
      >
        <div
          ref={bodySlotRef}
          className={cn("flex min-h-0 flex-1 flex-col", !activeSurface && "hidden")}
        />
        {activeSurface ? null : props.open ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center text-sm text-muted-foreground">
            <p>
              <T>No terminal</T>
            </p>
            <Button
              size="xs"
              variant="outline"
              disabled={!props.terminalAvailable}
              onClick={props.onNewTerminal}
            >
              <T>New terminal</T>
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
});

function DrawerIconButton(props: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={props.label}
            disabled={props.disabled}
            onClick={props.onClick}
            size="icon-xs"
            variant="ghost-muted"
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}
