import type { PreviewSessionSnapshot } from "@t3tools/contracts";
import { ContextMenu } from "@base-ui/react/context-menu";
import {
  ClipboardList,
  Activity,
  FileDiff,
  Files,
  GitPullRequest,
  Globe2,
  Maximize2,
  Minimize2,
  PanelBottom,
  PanelRight,
  Plus,
  Smartphone,
  TerminalSquare,
  X,
} from "lucide-react";
import { type MouseEvent, type ReactNode, useEffect, useRef, useState } from "react";

import type { RightPanelSurface } from "~/rightPanelStore";
import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import { useBrowserDefaults } from "~/browser/browserDefaults";
import { useTheme } from "~/hooks/useTheme";
import { PreviewPanelShell, type PreviewPanelMode } from "./preview/PreviewPanelShell";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
import { ScrollArea } from "./ui/scroll-area";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "./ui/menu";

type Props = {
  readonly mode: PreviewPanelMode;
  readonly surfaces: readonly RightPanelSurface[];
  readonly activeSurfaceId: string | null;
  readonly previewSessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  readonly terminalLabels: Readonly<Record<string, string>>;
  readonly onActivate: (surface: RightPanelSurface) => void;
  readonly onClose: (surface: RightPanelSurface) => void;
  readonly onCloseOthers: (surface: RightPanelSurface) => void;
  readonly onCloseToRight: (surface: RightPanelSurface) => void;
  readonly onCloseAll: () => void;
  readonly onClosePanel: () => void;
  readonly onCopyPath: (path: string) => void;
  readonly onAddBrowserInProfile: (profileId: string) => void;
  readonly onAddTerminal: () => void;
  readonly onAddFiles: () => void;
  readonly onAddDiff: () => void;
  readonly onAddInsights: () => void;
  readonly onAddDevice?: () => void;
  readonly onAddPullRequests?: () => void;
  readonly dirtyFilePaths?: ReadonlySet<string>;
  readonly showAddSurface?: boolean;
  readonly maximized?: boolean;
  readonly onToggleMaximize?: () => void;
  readonly terminalOpen?: boolean;
  readonly onToggleTerminal?: () => void;
  readonly children: ReactNode;
};

function titleFor(
  surface: RightPanelSurface,
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>,
  terminalLabels: Readonly<Record<string, string>>,
): string {
  switch (surface.kind) {
    case "plan":
      return "Plan";
    case "diff":
      return "Diff";
    case "files":
      return "Files";
    case "insights":
      return "Insights";
    case "file":
      return surface.relativePath.split("/").at(-1) ?? surface.relativePath;
    case "terminal":
      return terminalLabels[surface.resourceId] ?? "Terminal";
    case "pull-request":
      return surface.title
        ? `#${surface.reference.number} ${surface.title}`
        : `Pull request #${surface.reference.number}`;
    case "pull-requests":
      return "Pull requests";
    case "device":
      return surface.title ?? surface.target?.name ?? "Device";
    case "preview": {
      const snapshot = surface.resourceId ? sessions[surface.resourceId] : null;
      if (!snapshot || snapshot.navStatus._tag === "Idle") return "Browser";
      try {
        return snapshot.navStatus.title || new URL(snapshot.navStatus.url).host || "Browser";
      } catch {
        return snapshot.navStatus.title || "Browser";
      }
    }
  }
}

function PreviewIcon({ url }: { readonly url: string | null }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) return <Globe2 className="size-3.5" />;
  try {
    const favicon = new URL("/favicon.ico", url).toString();
    return (
      <img
        alt=""
        aria-hidden
        className="size-3.5 rounded-sm"
        src={favicon}
        onError={() => setFailed(true)}
      />
    );
  } catch {
    return <Globe2 className="size-3.5" />;
  }
}

function Icon({
  surface,
  sessions,
  theme,
}: {
  readonly surface: RightPanelSurface;
  readonly sessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  readonly theme: "light" | "dark";
}) {
  switch (surface.kind) {
    case "plan":
      return <ClipboardList className="size-3.5" />;
    case "diff":
      return <FileDiff className="size-3.5" />;
    case "files":
      return <Files className="size-3.5" />;
    case "file":
      return (
        <VscodeEntryIcon
          pathValue={surface.relativePath}
          kind="file"
          theme={theme}
          className="size-3.5"
        />
      );
    case "insights":
      return <Activity className="size-3.5" />;
    case "terminal":
      return <TerminalSquare className="size-3.5" />;
    case "pull-request":
      return <GitPullRequest className="size-3.5" />;
    case "pull-requests":
      return <GitPullRequest className="size-3.5" />;
    case "device":
      return <Smartphone className="size-3.5" />;
    case "preview": {
      const status = surface.resourceId ? sessions[surface.resourceId]?.navStatus : undefined;
      const url = status && status._tag !== "Idle" ? status.url : null;
      return <PreviewIcon url={url} />;
    }
  }
}

export function RightPanelTabs({
  mode,
  surfaces,
  activeSurfaceId,
  previewSessions,
  terminalLabels,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onCloseAll,
  onClosePanel,
  onCopyPath,
  onAddBrowserInProfile,
  onAddTerminal,
  onAddFiles,
  onAddDiff,
  onAddInsights,
  onAddDevice,
  onAddPullRequests,
  dirtyFilePaths,
  showAddSurface = true,
  maximized = false,
  onToggleMaximize,
  terminalOpen = false,
  onToggleTerminal,
  children,
}: Props) {
  const browserProfiles = useBrowserDefaults().profiles;
  const { resolvedTheme } = useTheme();
  const tabListRef = useRef<HTMLDivElement>(null);
  const activeSurface = surfaces.find((surface) => surface.id === activeSurfaceId);
  useEffect(() => {
    const list = tabListRef.current;
    if (!list) return;
    const revealActive = () =>
      list
        .querySelector<HTMLElement>("[data-active-tab='true']")
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    revealActive();
    const observer = new ResizeObserver(revealActive);
    observer.observe(list);
    return () => observer.disconnect();
  }, [activeSurfaceId, surfaces]);
  const closeOnMiddleClick = (event: MouseEvent, surface: RightPanelSurface) => {
    if (event.button !== 1) return;
    event.preventDefault();
    onClose(surface);
  };

  return (
    <PreviewPanelShell mode={mode} maximized={maximized}>
      <div
        className={cn(
          "flex h-11 shrink-0 items-center gap-1 border-b border-border/70 bg-chat-background px-2",
          isElectron && mode === "inline" && "drag-region",
        )}
        data-right-panel-tabbar
      >
        <ScrollArea
          ref={tabListRef}
          hideScrollbars
          scrollFade
          className="min-w-0 flex-1"
          data-right-panel-tab-list
        >
          <div className="flex h-full w-max items-center gap-0.5">
            {surfaces.map((surface) => {
              const title = titleFor(surface, previewSessions, terminalLabels);
              const fullTitle = surface.kind === "file" ? surface.relativePath : title;
              const dirty =
                surface.kind === "file" && (dirtyFilePaths?.has(surface.relativePath) ?? false);
              const active = surface.id === activeSurfaceId;
              return (
                <ContextMenu.Root key={surface.id}>
                  <ContextMenu.Trigger
                    render={<div />}
                    data-active-tab={active}
                    onMouseDown={(event) => {
                      if (event.button === 1) event.preventDefault();
                    }}
                    onAuxClick={(event) => closeOnMiddleClick(event, surface)}
                    className={cn(
                      "group flex h-6 min-w-0 max-w-36 shrink-0 items-center gap-0.5 rounded-md pl-1.5 pr-2 text-xs [-webkit-app-region:no-drag]",
                      active
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                    )}
                  >
                    <button
                      type="button"
                      aria-label={`Close ${title}`}
                      onClick={() => onClose(surface)}
                      className="relative flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-muted focus-visible:outline focus-visible:outline-ring"
                    >
                      <span className="group-hover:hidden group-focus-within:hidden">
                        <Icon surface={surface} sessions={previewSessions} theme={resolvedTheme} />
                      </span>
                      <X className="hidden size-3 group-hover:block group-focus-within:block" />
                    </button>
                    <button
                      type="button"
                      title={fullTitle}
                      onClick={() => onActivate(surface)}
                      className="flex min-w-0 flex-1 items-center gap-1 py-0.5 text-left focus-visible:outline focus-visible:outline-ring"
                    >
                      <span className="min-w-0 flex-1 truncate text-left">{title}</span>
                    </button>
                    {dirty ? (
                      <span
                        role="img"
                        aria-label="Unsaved changes"
                        title="Unsaved changes"
                        className="size-1.5 shrink-0 rounded-full bg-amber-500"
                      />
                    ) : null}
                  </ContextMenu.Trigger>
                  <MenuPopup>
                    {surface.kind === "file" ? (
                      <>
                        <MenuItem onClick={() => onCopyPath(surface.relativePath)}>
                          Copy path
                        </MenuItem>
                        <MenuSeparator />
                      </>
                    ) : null}
                    <MenuItem onClick={() => onClose(surface)}>Close</MenuItem>
                    <MenuItem
                      disabled={surfaces.length <= 1}
                      onClick={() => onCloseOthers(surface)}
                    >
                      Close others
                    </MenuItem>
                    <MenuItem
                      disabled={surfaces.indexOf(surface) === surfaces.length - 1}
                      onClick={() => onCloseToRight(surface)}
                    >
                      Close to the right
                    </MenuItem>
                    <MenuItem disabled={surfaces.length === 0} onClick={onCloseAll}>
                      Close all
                    </MenuItem>
                  </MenuPopup>
                </ContextMenu.Root>
              );
            })}
            {showAddSurface ? (
              <Menu>
                <MenuTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Add surface"
                      className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      <Plus className="size-3.5" />
                    </button>
                  }
                />
                <MenuPopup>
                  <MenuSub>
                    <MenuSubTrigger>Browser</MenuSubTrigger>
                    <MenuSubPopup className="min-w-40 max-w-56">
                      {browserProfiles.map((profile) => (
                        <MenuItem
                          key={profile.id}
                          onClick={() => onAddBrowserInProfile(profile.id)}
                        >
                          <span className="min-w-0 truncate">{profile.name}</span>
                        </MenuItem>
                      ))}
                    </MenuSubPopup>
                  </MenuSub>
                  <MenuItem onClick={onAddTerminal}>Terminal</MenuItem>
                  <MenuItem onClick={onAddFiles}>Files</MenuItem>
                  <MenuItem onClick={onAddDiff}>Diff</MenuItem>
                  <MenuItem onClick={onAddInsights}>Insights</MenuItem>
                  {onAddDevice ? <MenuItem onClick={onAddDevice}>Device</MenuItem> : null}
                  {onAddPullRequests ? (
                    <MenuItem onClick={onAddPullRequests}>Pull requests</MenuItem>
                  ) : null}
                </MenuPopup>
              </Menu>
            ) : null}
          </div>
        </ScrollArea>
        {onToggleTerminal ? (
          <button
            type="button"
            aria-label={terminalOpen ? "Hide terminal drawer" : "Show terminal drawer"}
            aria-pressed={terminalOpen}
            onClick={onToggleTerminal}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground [-webkit-app-region:no-drag]"
          >
            <PanelBottom className="size-3.5" />
          </button>
        ) : null}
        {onToggleMaximize ? (
          <button
            type="button"
            aria-label={maximized ? "Restore panel size" : "Maximize panel"}
            onClick={onToggleMaximize}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground [-webkit-app-region:no-drag]"
          >
            {maximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </button>
        ) : null}
        <button
          type="button"
          aria-label={
            activeSurface?.kind === "preview" ? "Close browser panel" : "Hide right panel"
          }
          onClick={onClosePanel}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground [-webkit-app-region:no-drag]"
        >
          <PanelRight className="size-3.5" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </PreviewPanelShell>
  );
}
