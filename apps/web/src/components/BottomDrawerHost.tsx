import { scopeThreadRef } from "@forma/client-runtime";
import { useParams } from "@tanstack/react-router";
import { IconRectangleOnRectangle as PreviewIcon, IconXmark as CloseIcon } from "symbols-react";
import { TerminalToggleIcon } from "./icons/custom";
import { type ReactNode, useMemo } from "react";

import { resolveThreadRouteTarget } from "../threadRoutes";
import { useBottomDrawerUiStore } from "../bottomDrawerUiStore";
import { useComposerDraftStore } from "../composerDraftStore";
import { shortcutLabelForCommand } from "../keybindings";
import { useTerminalStateStore } from "../terminalStateStore";
import { useServerKeybindings } from "../rpc/serverState";
import { PersistentThreadTerminalDrawer } from "./PersistentThreadTerminalDrawer";
import { PreviewDrawer } from "./PreviewDrawer";
import { Button } from "./ui/button";
import { cn } from "~/lib/utils";

function DrawerTabButton(props: {
  active: boolean;
  disabled?: boolean;
  label: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
        props.active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
        props.disabled &&
          "cursor-not-allowed opacity-45 hover:bg-transparent hover:text-muted-foreground",
      )}
    >
      {props.icon}
      {props.label}
    </button>
  );
}

export function BottomDrawerHost() {
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const draftThread = useComposerDraftStore((state) =>
    routeTarget?.kind === "draft" ? state.getDraftSession(routeTarget.draftId) : null,
  );
  const activeThreadRef =
    routeTarget?.kind === "server"
      ? routeTarget.threadRef
      : draftThread
        ? scopeThreadRef(draftThread.environmentId, draftThread.threadId)
        : null;
  const visibleMode = useBottomDrawerUiStore((state) => state.visibleMode);
  const showTerminal = useBottomDrawerUiStore((state) => state.showTerminal);
  const showPreview = useBottomDrawerUiStore((state) => state.showPreview);
  const closeVisibleMode = useBottomDrawerUiStore((state) => state.closeVisibleMode);
  const keybindings = useServerKeybindings();
  const setTerminalOpen = useTerminalStateStore((state) => state.setTerminalOpen);

  const terminalTabLabel = useMemo(
    () =>
      shortcutLabelForCommand(keybindings, "terminal.toggle", {
        context: {
          terminalFocus: true,
          terminalOpen: true,
        },
      }),
    [keybindings],
  );

  if (visibleMode === "hidden") {
    return null;
  }

  const terminalAvailable = activeThreadRef !== null;

  return (
    <div className="relative shrink-0">
      {visibleMode === "terminal" && activeThreadRef ? (
        <PersistentThreadTerminalDrawer
          threadRef={activeThreadRef}
          threadId={activeThreadRef.threadId}
          visible
          splitShortcutLabel={
            shortcutLabelForCommand(keybindings, "terminal.split", {
              context: { terminalFocus: true, terminalOpen: true },
            }) ?? undefined
          }
          newShortcutLabel={
            shortcutLabelForCommand(keybindings, "terminal.new", {
              context: { terminalFocus: true, terminalOpen: true },
            }) ?? undefined
          }
          closeShortcutLabel={
            shortcutLabelForCommand(keybindings, "terminal.close", {
              context: { terminalFocus: true, terminalOpen: true },
            }) ?? undefined
          }
          keybindings={keybindings}
        />
      ) : null}
      {visibleMode === "preview" ? <PreviewDrawer /> : null}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex items-start justify-between px-3 pt-2">
        <div className="pointer-events-auto inline-flex items-center gap-1 rounded-lg border border-border/80 bg-card/88 p-1 shadow-sm backdrop-blur">
          <DrawerTabButton
            active={visibleMode === "preview"}
            icon={<PreviewIcon className="size-3.5" />}
            label="Preview"
            onClick={showPreview}
          />
          <DrawerTabButton
            active={visibleMode === "terminal"}
            disabled={!terminalAvailable}
            icon={<TerminalToggleIcon className="size-3.5" />}
            label={terminalTabLabel ? `Terminal (${terminalTabLabel})` : "Terminal"}
            onClick={() => {
              if (!activeThreadRef) {
                return;
              }
              setTerminalOpen(activeThreadRef, true);
              showTerminal();
            }}
          />
        </div>
        <div className="pointer-events-auto">
          <Button
            size="icon-xs"
            variant="outline"
            onClick={closeVisibleMode}
            aria-label="Close drawer"
          >
            <CloseIcon className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
