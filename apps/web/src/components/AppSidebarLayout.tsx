import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { isElectron } from "../env";
import { getLocalStorageItem } from "../hooks/useLocalStorage";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { cn, isMacPlatform } from "../lib/utils";
import { primaryServerKeybindingsAtom } from "../state/server";
import { useEnvironmentIdentificationMode, useLegacySidebarEnabled } from "../hooks/useSettings";
import LegacyThreadSidebar from "./LegacySidebar";
import ThreadSidebar from "./Sidebar";
import { SettingsSidebarNav } from "./settings/SettingsSidebarNav";
import { SidebarChromeHeader } from "./sidebar/SidebarChrome";
import {
  resolveSidebarStageFocusRingOffsetClass,
  useSidebarStageBackdropVariant,
} from "./SidebarStageBackdrop";
import { useProjects } from "../state/entities";
import {
  resolveThreadSidebarCssWidth,
  resolveThreadSidebarMaximumWidth,
  THREAD_MAIN_CONTENT_MIN_WIDTH,
  THREAD_SIDEBAR_DEFAULT_WIDTH,
  THREAD_SIDEBAR_MIN_WIDTH,
  THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
} from "./threadSidebarWidth";
import {
  Sidebar,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
  useSidebarVisibility,
} from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const MACOS_TRAFFIC_LIGHTS_LEFT_INSET = "90px";

function readInitialThreadSidebarWidth(): number {
  try {
    const storedWidth = getLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY, Schema.Finite);
    return storedWidth === null
      ? THREAD_SIDEBAR_DEFAULT_WIDTH
      : Math.max(THREAD_SIDEBAR_MIN_WIDTH, storedWidth);
  } catch (error) {
    console.error("Could not read persisted thread sidebar width.", error);
    return THREAD_SIDEBAR_DEFAULT_WIDTH;
  }
}

function SidebarControl() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { toggleSidebar } = useSidebar();
  const isSidebarVisible = useSidebarVisibility();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const stageBackdropVariant = useSidebarStageBackdropVariant(
    environmentIdentificationMode === "artwork",
  );
  const shortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.toggle");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture]")
      ) {
        return;
      }
      if (resolveShortcutCommand(event, keybindings) !== "sidebar.toggle") return;

      event.preventDefault();
      event.stopPropagation();
      toggleSidebar();
    };

    // Capture before focused editors consume commands such as Mod+B for rich-text formatting.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [keybindings, toggleSidebar]);

  return (
    <div
      className="pointer-events-none fixed left-[var(--workspace-controls-left)] top-[var(--workspace-controls-top)] z-50 flex h-[var(--workspace-topbar-height)] items-center"
      data-sidebar-control=""
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarTrigger
              className={cn(
                "pointer-events-auto",
                isSidebarVisible &&
                  stageBackdropVariant &&
                  "focus-visible:ring-white/90 [&_svg]:stroke-white/90! [&_svg]:opacity-100! [&_svg]:hover:stroke-white! [:hover,[data-pressed]]:bg-white/15",
                isSidebarVisible &&
                  stageBackdropVariant &&
                  resolveSidebarStageFocusRingOffsetClass(stageBackdropVariant),
              )}
              aria-label="Toggle main sidebar"
            />
          }
        />
        <TooltipPopup side="bottom">
          Toggle main sidebar{shortcutLabel ? ` (${shortcutLabel})` : ""}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

// Settings swaps the thread sidebar out of the tree. Keep the lightweight
// project projection subscribed so returning to a draft never renders the
// zero-project state while the environment snapshot reconnects.
function ProjectProjectionRetention() {
  useProjects();
  return null;
}

export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const legacySidebarEnabled = useLegacySidebarEnabled();
  // Settings routes show the settings nav in place of whichever thread
  // sidebar is active.
  const pathname = useLocation({ select: (location) => location.pathname });
  const isOnSettings = pathname === "/settings" || pathname.startsWith("/settings/");
  const isMacosDesktop = isElectron && isMacPlatform(navigator.platform);
  const [sidebarWidth, setSidebarWidth] = useState(readInitialThreadSidebarWidth);
  const sidebarResizable = useMemo(
    () => ({
      getCssWidth: resolveThreadSidebarCssWidth,
      maxWidth: () => resolveThreadSidebarMaximumWidth(window.innerWidth),
      minWidth: THREAD_SIDEBAR_MIN_WIDTH,
      shouldAcceptWidth: ({
        currentWidth,
        nextWidth,
        wrapper,
      }: {
        currentWidth: number;
        nextWidth: number;
        wrapper: HTMLElement;
      }) =>
        nextWidth <= currentWidth ||
        wrapper.clientWidth - nextWidth >= THREAD_MAIN_CONTENT_MIN_WIDTH,
      storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
      hydrateStoredWidth: false,
      onResize: setSidebarWidth,
    }),
    [],
  );
  const [isWindowFullscreen, setIsWindowFullscreen] = useState(() => {
    const getWindowFullscreenState = window.desktopBridge?.getWindowFullscreenState;
    return isMacosDesktop && typeof getWindowFullscreenState === "function"
      ? getWindowFullscreenState()
      : false;
  });
  const sidebarProviderStyle = {
    "--sidebar-width": resolveThreadSidebarCssWidth(sidebarWidth),
    ...(isMacosDesktop && !isWindowFullscreen
      ? { "--workspace-controls-left": MACOS_TRAFFIC_LIGHTS_LEFT_INSET }
      : {}),
  } as CSSProperties;

  useEffect(() => {
    if (!isMacosDesktop) return;
    const bridge = window.desktopBridge;
    if (!bridge) return;
    const { getWindowFullscreenState, onWindowFullscreenStateChange } = bridge;
    if (
      typeof getWindowFullscreenState !== "function" ||
      typeof onWindowFullscreenStateChange !== "function"
    ) {
      return;
    }

    const unsubscribe = onWindowFullscreenStateChange(setIsWindowFullscreen);
    setIsWindowFullscreen(getWindowFullscreenState());
    return unsubscribe;
  }, [isMacosDesktop]);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action === "open-settings") {
        const isSettingsRoute = /^\/settings(\/|$)/.test(pathname);
        if (!isSettingsRoute) {
          void navigate({ to: "/settings" });
        }
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate, pathname]);

  return (
    <SidebarProvider className="h-dvh! min-h-0!" defaultOpen style={sidebarProviderStyle}>
      <ProjectProjectionRetention />
      <Sidebar
        side="left"
        collapsible="offcanvas"
        data-app-sidebar=""
        className="border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
        resizable={sidebarResizable}
      >
        {isOnSettings ? (
          <>
            <SidebarChromeHeader isElectron={isElectron} />
            <SettingsSidebarNav pathname={pathname} />
          </>
        ) : legacySidebarEnabled ? (
          <LegacyThreadSidebar />
        ) : (
          <ThreadSidebar />
        )}
        <SidebarRail />
      </Sidebar>
      {children}
      <SidebarControl />
    </SidebarProvider>
  );
}
