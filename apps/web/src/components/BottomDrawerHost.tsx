import { scopeThreadRef } from "@forma/client-runtime";
import { useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { resolveThreadRouteTarget } from "../threadRoutes";
import { useBottomDrawerUiStore } from "../bottomDrawerUiStore";
import { useComposerDraftStore } from "../composerDraftStore";
import { shortcutLabelForCommand } from "../keybindings";
import { useServerKeybindings } from "../rpc/serverState";
import { cn } from "~/lib/utils";
import { PersistentThreadTerminalDrawer } from "./PersistentThreadTerminalDrawer";
import { PreviewDrawer } from "./PreviewDrawer";

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
  const fullHeight = useBottomDrawerUiStore((state) => state.isFullHeight);
  const keybindings = useServerKeybindings();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [overlayTop, setOverlayTop] = useState(0);

  useEffect(() => {
    if (!fullHeight || visibleMode === "hidden") {
      setOverlayTop(0);
      return;
    }

    const updateOverlayTop = () => {
      const host = hostRef.current;
      const parent = host?.parentElement;
      if (!host || !parent) {
        setOverlayTop(0);
        return;
      }
      const parentRect = parent.getBoundingClientRect();
      const anchor = parent.querySelector<HTMLElement>("[data-bottom-drawer-anchor='true']");
      if (!anchor) {
        setOverlayTop(0);
        return;
      }
      const anchorRect = anchor.getBoundingClientRect();
      setOverlayTop(Math.max(0, Math.round(anchorRect.top - parentRect.top)));
    };

    updateOverlayTop();
    window.addEventListener("resize", updateOverlayTop);
    return () => {
      window.removeEventListener("resize", updateOverlayTop);
    };
  }, [fullHeight, visibleMode]);

  if (visibleMode === "hidden") {
    return null;
  }

  return (
    <div
      ref={hostRef}
      className={cn(fullHeight ? "absolute inset-x-0 bottom-0 z-40 min-h-0" : "shrink-0")}
      style={fullHeight ? { top: `${overlayTop}px` } : undefined}
    >
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
    </div>
  );
}
