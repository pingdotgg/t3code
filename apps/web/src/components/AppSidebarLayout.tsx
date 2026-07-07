import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";

import { isElectron } from "../env";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { isMacPlatform } from "../lib/utils";
import { useActiveEnvironmentId } from "../state/entities";
import { primaryServerConfigAtom, primaryServerKeybindingsAtom } from "../state/server";
import ThreadSidebar from "./Sidebar";
import { Sidebar, SidebarProvider, SidebarRail, SidebarTrigger, useSidebar } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16;
const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;
const MACOS_TRAFFIC_LIGHTS_LEFT_INSET = "90px";

function SidebarControl() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { toggleSidebar } = useSidebar();
  const shortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.toggle");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (resolveShortcutCommand(event, keybindings) !== "sidebar.toggle") return;

      event.preventDefault();
      event.stopPropagation();
      toggleSidebar();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, toggleSidebar]);

  return (
    <div
      className="pointer-events-none fixed left-[var(--workspace-controls-left)] top-[var(--workspace-controls-top)] z-50 flex h-[var(--workspace-topbar-height)] items-center"
      data-sidebar-control=""
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarTrigger className="pointer-events-auto" aria-label="Toggle main sidebar" />
          }
        />
        <TooltipPopup side="bottom">
          Toggle main sidebar{shortcutLabel ? ` (${shortcutLabel})` : ""}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const activeEnvironmentId = useActiveEnvironmentId();
  const serverConfig = useAtomValue(primaryServerConfigAtom);
  const pendingThreadIdRef = useRef<string | null>(null);
  const macosWindowControlsStyle =
    isElectron && isMacPlatform(navigator.platform)
      ? ({ "--workspace-controls-left": MACOS_TRAFFIC_LIGHTS_LEFT_INSET } as CSSProperties)
      : undefined;

  const resolveEnvironmentId = () =>
    activeEnvironmentId ?? serverConfig?.environment.environmentId ?? null;

  useEffect(() => {
    const environmentId = resolveEnvironmentId();
    const pendingThreadId = pendingThreadIdRef.current;
    if (!environmentId || !pendingThreadId) {
      return;
    }

    pendingThreadIdRef.current = null;
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: pendingThreadId },
    });
  }, [activeEnvironmentId, navigate, serverConfig]);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action === "open-settings") {
        void navigate({ to: "/settings" });
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate]);

  useEffect(() => {
    const onOpenThread = window.desktopBridge?.onOpenThread;
    if (typeof onOpenThread !== "function") {
      return;
    }

    const unsubscribe = onOpenThread((threadId) => {
      const environmentId = resolveEnvironmentId();
      if (!environmentId) {
        pendingThreadIdRef.current = threadId;
        return;
      }

      pendingThreadIdRef.current = null;
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId },
      });
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate, activeEnvironmentId, serverConfig]);

  return (
    <SidebarProvider className="h-dvh! min-h-0!" defaultOpen style={macosWindowControlsStyle}>
      <Sidebar
        side="left"
        collapsible="offcanvas"
        className="border-r border-border bg-card text-foreground"
        resizable={{
          minWidth: THREAD_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: ({ nextWidth, wrapper }) =>
            wrapper.clientWidth - nextWidth >= THREAD_MAIN_CONTENT_MIN_WIDTH,
          storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        <ThreadSidebar />
        <SidebarRail />
      </Sidebar>
      {children}
      <SidebarControl />
    </SidebarProvider>
  );
}
