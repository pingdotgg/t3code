import type { ContextMenuItem, PreviewSessionSnapshot } from "@t3tools/contracts";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import {
  Bot,
  ClipboardList,
  FileDiff,
  Files,
  Gauge,
  Globe2,
  Plus,
  TerminalSquare,
  X,
} from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { isElectron } from "~/env";
import type { RightPanelSurface } from "~/rightPanelStore";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { ScrollArea } from "~/components/ui/scroll-area";
import { faviconUrlForOrigin } from "~/lib/favicon";
import { useTheme } from "~/hooks/useTheme";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { useI18n, type Translate } from "~/i18n";

import { PreviewPanelShell, type PreviewPanelMode } from "./preview/PreviewPanelShell";
import { PierreEntryIcon } from "./chat/PierreEntryIcon";

interface RightPanelTabsProps {
  mode: PreviewPanelMode;
  maximized?: boolean;
  layoutControls?: ReactNode;
  surfaces: readonly RightPanelSurface[];
  activeSurfaceId: string | null;
  pendingSurfaceIds: ReadonlySet<string>;
  previewSessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  terminalLabelsById: ReadonlyMap<string, string>;
  onActivate: (surface: RightPanelSurface) => void;
  onCloseSurface: (surface: RightPanelSurface) => void;
  onCloseOtherSurfaces: (surface: RightPanelSurface) => void;
  onCloseSurfacesToRight: (surface: RightPanelSurface) => void;
  onCloseAllSurfaces: () => void;
  onCopyFilePath: (relativePath: string) => void;
  onAddBrowser: () => void;
  onAddTerminal: () => void;
  onAddDiff: () => void;
  onAddFiles: () => void;
  onAddContext: () => void;
  browserAvailable: boolean;
  diffAvailable: boolean;
  filesAvailable: boolean;
  contextAvailable: boolean;
  children: ReactNode;
}

type TabContextMenuAction = "copy-path" | "close" | "close-others" | "close-to-right" | "close-all";

function DisabledReasonTooltip(props: { reason: string; trigger: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={props.trigger} />
      <TooltipPopup side="top">{props.reason}</TooltipPopup>
    </Tooltip>
  );
}

function SurfaceMenuItem(props: {
  available: boolean;
  disabledReason?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const item = (
    <MenuItem
      className={!props.available ? "data-disabled:pointer-events-auto" : undefined}
      onClick={props.onClick}
      disabled={!props.available}
    >
      {props.children}
    </MenuItem>
  );
  if (props.available || !props.disabledReason) return item;
  return <DisabledReasonTooltip reason={props.disabledReason} trigger={item} />;
}

function RightPanelEmptyState(props: {
  onAddBrowser: () => void;
  onAddTerminal: () => void;
  onAddDiff: () => void;
  onAddFiles: () => void;
  onAddContext: () => void;
  browserAvailable: boolean;
  diffAvailable: boolean;
  filesAvailable: boolean;
  contextAvailable: boolean;
}) {
  const { t } = useI18n();
  const disabledReasons = {
    browser: t("panel.browserUnavailable"),
    files: t("panel.filesUnavailable"),
    diff: t("panel.diffUnavailable"),
    context: t("panel.contextUnavailable"),
  } as const;
  const actions = [
    {
      label: t("panel.browser"),
      description: t("panel.browserDescription"),
      icon: Globe2,
      available: props.browserAvailable,
      disabledReason: disabledReasons.browser,
      onClick: props.onAddBrowser,
    },
    {
      label: t("panel.terminal"),
      description: t("panel.terminalDescription"),
      icon: TerminalSquare,
      available: true,
      disabledReason: null,
      onClick: props.onAddTerminal,
    },
    {
      label: t("panel.files"),
      description: t("panel.filesDescription"),
      icon: Files,
      available: props.filesAvailable,
      disabledReason: disabledReasons.files,
      onClick: props.onAddFiles,
    },
    {
      label: t("panel.diff"),
      description: t("panel.diffDescription"),
      icon: FileDiff,
      available: props.diffAvailable,
      disabledReason: disabledReasons.diff,
      onClick: props.onAddDiff,
    },
    {
      label: t("panel.context"),
      description: t("panel.contextDescription"),
      icon: Gauge,
      available: props.contextAvailable,
      disabledReason: disabledReasons.context,
      onClick: props.onAddContext,
    },
  ] as const;

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="w-full max-w-xl">
        <div className="mb-5 text-center">
          <h3 className="text-sm font-medium text-foreground">{t("panel.openSurface")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t("panel.openSurfaceDescription")}</p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {actions.map((action) => {
            const Icon = action.icon;
            const content = (
              <>
                <Icon className="mb-3 size-5" />
                <span className="text-sm font-medium">{action.label}</span>
                <span className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {action.description}
                </span>
              </>
            );
            if (action.available) {
              return (
                <button
                  key={action.label}
                  type="button"
                  onClick={action.onClick}
                  className="flex min-h-28 w-full flex-col items-start rounded-lg border border-border/80 bg-card/40 p-4 text-left transition hover:border-border hover:bg-accent/60"
                >
                  {content}
                </button>
              );
            }
            const disabledCard = (
              <button
                type="button"
                className="flex min-h-28 w-full cursor-not-allowed flex-col items-start rounded-lg border border-border/80 bg-card/40 p-4 text-left opacity-40"
                aria-disabled="true"
              >
                {content}
              </button>
            );
            return (
              <DisabledReasonTooltip
                key={action.label}
                reason={action.disabledReason}
                trigger={disabledCard}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function surfaceTitle(
  surface: RightPanelSurface,
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>,
  terminalLabelsById: ReadonlyMap<string, string>,
  t: Translate,
): string {
  switch (surface.kind) {
    case "diff":
      return t("panel.diff");
    case "context":
      return t("panel.context");
    case "files":
      return t("panel.files");
    case "file":
      return surface.relativePath.slice(surface.relativePath.lastIndexOf("/") + 1);
    case "terminal":
      return (
        terminalLabelsById.get(surface.activeTerminalId) ??
        getTerminalLabel(surface.activeTerminalId)
      );
    case "plan":
      return t("panel.plan");
    case "subagent":
      return surface.title || t("panel.subagent");
    case "preview": {
      const snapshot = surface.resourceId ? sessions[surface.resourceId] : null;
      if (!snapshot || snapshot.navStatus._tag === "Idle") return t("panel.browser");
      if (snapshot.navStatus.title.trim().length > 0) return snapshot.navStatus.title;
      try {
        return new URL(snapshot.navStatus.url).host || t("panel.browser");
      } catch {
        return t("panel.browser");
      }
    }
  }
}

function PreviewFavicon({ url }: { url: string | null }) {
  const faviconUrl = faviconUrlForOrigin(url, 32);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (!faviconUrl || failedUrl === faviconUrl) return <Globe2 className="size-3.5 shrink-0" />;
  return (
    <img
      src={faviconUrl}
      alt=""
      aria-hidden
      draggable={false}
      className="size-3.5 shrink-0 rounded-sm"
      onError={() => setFailedUrl(faviconUrl)}
    />
  );
}

function SurfaceIcon({
  surface,
  sessions,
  theme,
}: {
  surface: RightPanelSurface;
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  theme: "light" | "dark";
}) {
  switch (surface.kind) {
    case "preview": {
      const snapshot = surface.resourceId ? sessions[surface.resourceId] : null;
      const url = !snapshot || snapshot.navStatus._tag === "Idle" ? null : snapshot.navStatus.url;
      return <PreviewFavicon url={url} />;
    }
    case "diff":
      return <FileDiff className="size-3.5 shrink-0" />;
    case "context":
      return <Gauge className="size-3.5 shrink-0" />;
    case "files":
      return <Files className="size-3.5 shrink-0" />;
    case "file":
      return (
        <PierreEntryIcon
          pathValue={surface.relativePath}
          kind="file"
          theme={theme}
          className="size-3.5"
        />
      );
    case "terminal":
      return <TerminalSquare className="size-3.5 shrink-0" />;
    case "plan":
      return <ClipboardList className="size-3.5 shrink-0" />;
    case "subagent":
      return <Bot className="size-3.5 shrink-0" />;
  }
}

export function RightPanelTabs(props: RightPanelTabsProps) {
  const { t } = useI18n();
  const ownsDesktopTitleBar = isElectron && props.mode === "inline";
  const { resolvedTheme } = useTheme();
  const tabListRef = useRef<HTMLDivElement>(null);

  const handleTabContextMenu = useCallback(
    async (event: ReactMouseEvent, surface: RightPanelSurface) => {
      event.preventDefault();
      event.stopPropagation();

      const api = readLocalApi();
      if (!api) return;

      const surfaceIndex = props.surfaces.findIndex((entry) => entry.id === surface.id);
      if (surfaceIndex < 0) return;

      const items: ContextMenuItem<TabContextMenuAction>[] = [];
      if (surface.kind === "file") {
        items.push({ id: "copy-path", label: t("panel.copyPath") });
      }
      items.push(
        { id: "close", label: t("panel.close") },
        {
          id: "close-others",
          label: t("panel.closeOthers"),
          disabled: props.surfaces.length <= 1,
        },
        {
          id: "close-to-right",
          label: t("panel.closeRight"),
          disabled: surfaceIndex >= props.surfaces.length - 1,
        },
        {
          id: "close-all",
          label: t("panel.closeAll"),
          disabled: props.surfaces.length === 0,
        },
      );

      const action = await api.contextMenu.show(items, { x: event.clientX, y: event.clientY });
      switch (action) {
        case "copy-path":
          if (surface.kind === "file") props.onCopyFilePath(surface.relativePath);
          break;
        case "close":
          props.onCloseSurface(surface);
          break;
        case "close-others":
          props.onCloseOtherSurfaces(surface);
          break;
        case "close-to-right":
          props.onCloseSurfacesToRight(surface);
          break;
        case "close-all":
          props.onCloseAllSurfaces();
          break;
        case null:
          break;
      }
    },
    [props, t],
  );
  const handleTabMouseDown = useCallback((event: ReactMouseEvent) => {
    if (event.button !== 1) return;
    event.preventDefault();
  }, []);
  const handleTabAuxClick = useCallback(
    (event: ReactMouseEvent, surface: RightPanelSurface) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      props.onCloseSurface(surface);
    },
    [props],
  );

  useEffect(() => {
    const activeTab = tabListRef.current?.querySelector<HTMLElement>("[data-active-tab='true']");
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [props.activeSurfaceId]);

  return (
    <PreviewPanelShell
      mode={props.mode}
      {...(props.maximized !== undefined ? { maximized: props.maximized } : {})}
    >
      <div
        className={cn(
          "workspace-topbar gap-1 pl-2",
          props.mode === "inline" ? "pr-28" : "pr-3",
          ownsDesktopTitleBar && "wco:pr-[calc(var(--workspace-native-controls-inset)+6rem)]",
          props.mode === "inline" && props.maximized && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
        data-right-panel-tabbar
      >
        <ScrollArea
          ref={tabListRef}
          hideScrollbars
          scrollFade
          className={cn("min-w-0 flex-1 rounded-none", ownsDesktopTitleBar && "drag-region")}
          data-right-panel-tab-list
        >
          <div className="flex h-full w-max min-w-full items-center gap-1">
            {props.surfaces.map((surface) => {
              const active = surface.id === props.activeSurfaceId;
              const pending = props.pendingSurfaceIds.has(surface.id);
              const title = surfaceTitle(
                surface,
                props.previewSessions,
                props.terminalLabelsById,
                t,
              );
              return (
                <div
                  key={surface.id}
                  data-active-tab={active}
                  onMouseDown={handleTabMouseDown}
                  onAuxClick={(event) => handleTabAuxClick(event, surface)}
                  onContextMenu={(event) => void handleTabContextMenu(event, surface)}
                  className={cn(
                    "group flex h-7 min-w-25 max-w-44 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm",
                    active
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-center gap-1.5"
                          onClick={() => props.onActivate(surface)}
                        >
                          <SurfaceIcon
                            surface={surface}
                            sessions={props.previewSessions}
                            theme={resolvedTheme}
                          />
                          <span className="truncate">{title}</span>
                        </button>
                      }
                    />
                    <TooltipPopup>{title}</TooltipPopup>
                  </Tooltip>
                  <button
                    type="button"
                    className={cn(
                      "relative flex size-4 shrink-0 items-center justify-center rounded hover:bg-muted focus:opacity-100",
                      pending ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                    )}
                    aria-label={t("panel.closeNamed", { title })}
                    onClick={() => props.onCloseSurface(surface)}
                  >
                    {pending ? (
                      <>
                        <span
                          className="size-2 rounded-full bg-current group-hover:hidden"
                          aria-hidden
                        />
                        <X className="hidden size-3 group-hover:block" />
                      </>
                    ) : (
                      <X className="size-3" />
                    )}
                  </button>
                </div>
              );
            })}
            {props.surfaces.length > 0 ? (
              <Menu>
                <MenuTrigger
                  className="relative inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label={t("panel.addSurface")}
                >
                  <Plus className="size-4" />
                </MenuTrigger>
                <MenuPopup align="start" side="bottom" sideOffset={6} className="min-w-44">
                  <SurfaceMenuItem
                    available={props.browserAvailable}
                    disabledReason={t("panel.browserUnavailable")}
                    onClick={props.onAddBrowser}
                  >
                    <Globe2 />
                    {t("panel.browser")}
                  </SurfaceMenuItem>
                  <SurfaceMenuItem available onClick={props.onAddTerminal}>
                    <TerminalSquare />
                    {t("panel.terminal")}
                  </SurfaceMenuItem>
                  <SurfaceMenuItem
                    available={props.filesAvailable}
                    disabledReason={t("panel.filesUnavailable")}
                    onClick={props.onAddFiles}
                  >
                    <Files />
                    {t("panel.files")}
                  </SurfaceMenuItem>
                  <SurfaceMenuItem
                    available={props.diffAvailable}
                    disabledReason={t("panel.diffUnavailable")}
                    onClick={props.onAddDiff}
                  >
                    <FileDiff />
                    {t("panel.diff")}
                  </SurfaceMenuItem>
                  <SurfaceMenuItem
                    available={props.contextAvailable}
                    disabledReason={t("panel.contextUnavailable")}
                    onClick={props.onAddContext}
                  >
                    <Gauge />
                    {t("panel.context")}
                  </SurfaceMenuItem>
                </MenuPopup>
              </Menu>
            ) : null}
          </div>
        </ScrollArea>
        {props.layoutControls}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {props.activeSurfaceId === null ? (
          <RightPanelEmptyState
            onAddBrowser={props.onAddBrowser}
            onAddTerminal={props.onAddTerminal}
            onAddDiff={props.onAddDiff}
            onAddFiles={props.onAddFiles}
            onAddContext={props.onAddContext}
            browserAvailable={props.browserAvailable}
            diffAvailable={props.diffAvailable}
            filesAvailable={props.filesAvailable}
            contextAvailable={props.contextAvailable}
          />
        ) : (
          props.children
        )}
      </div>
    </PreviewPanelShell>
  );
}
