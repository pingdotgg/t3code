import type { PreviewSessionSnapshot } from "@t3tools/contracts";
import {
  ClipboardList,
  Activity,
  FileDiff,
  Files,
  GitPullRequest,
  Globe2,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Plus,
  Smartphone,
  TerminalSquare,
  X,
} from "lucide-react";
import { type MouseEvent, type ReactNode, useState } from "react";

import type { RightPanelSurface } from "~/rightPanelStore";
import { cn } from "~/lib/utils";
import { useBrowserDefaults } from "~/browser/browserDefaults";
import { useTheme } from "~/hooks/useTheme";
import { PreviewPanelShell, type PreviewPanelMode } from "./preview/PreviewPanelShell";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
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
  children,
}: Props) {
  const browserProfiles = useBrowserDefaults().profiles;
  const { resolvedTheme } = useTheme();
  const activeSurface = surfaces.find((surface) => surface.id === activeSurfaceId);
  const closeOnMiddleClick = (event: MouseEvent, surface: RightPanelSurface) => {
    if (event.button !== 1) return;
    event.preventDefault();
    onClose(surface);
  };

  return (
    <PreviewPanelShell mode={mode} maximized={maximized}>
      <div
        className="flex h-8 shrink-0 items-center gap-1 border-b border-border/70 bg-muted/20 px-1.5"
        data-right-panel-tabbar
      >
        <div
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
          data-right-panel-tab-list
        >
          {surfaces.map((surface) => {
            const title = titleFor(surface, previewSessions, terminalLabels);
            const fullTitle = surface.kind === "file" ? surface.relativePath : title;
            const dirty =
              surface.kind === "file" && (dirtyFilePaths?.has(surface.relativePath) ?? false);
            const active = surface.id === activeSurfaceId;
            return (
              <div
                key={surface.id}
                className={cn(
                  "group flex h-6 min-w-0 max-w-44 shrink-0 items-center rounded-md border",
                  surface.kind === "preview" ? "text-[10px]" : "text-[11px]",
                  active
                    ? "border-border/70 bg-background text-foreground shadow-xs/5"
                    : "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <button
                  type="button"
                  title={fullTitle}
                  onClick={() => onActivate(surface)}
                  onAuxClick={(event) => closeOnMiddleClick(event, surface)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 pl-1.5"
                >
                  <Icon surface={surface} sessions={previewSessions} theme={resolvedTheme} />
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
                <Menu>
                  <MenuTrigger
                    render={
                      <button
                        type="button"
                        aria-label={`Actions for ${title}`}
                        className="rounded p-0.5 opacity-0 hover:bg-accent group-hover:opacity-100 focus:opacity-100"
                      >
                        <MoreHorizontal className="size-3" />
                      </button>
                    }
                  />
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
                </Menu>
                <button
                  type="button"
                  aria-label={`Close ${title}`}
                  onClick={() => onClose(surface)}
                  className="rounded p-0.5 opacity-0 hover:bg-accent group-hover:opacity-100 focus:opacity-100"
                >
                  <X className="size-3" />
                </button>
              </div>
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
                      <MenuItem key={profile.id} onClick={() => onAddBrowserInProfile(profile.id)}>
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
        {onToggleMaximize ? (
          <button
            type="button"
            aria-label={maximized ? "Restore panel size" : "Maximize panel"}
            onClick={onToggleMaximize}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {maximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </button>
        ) : null}
        {activeSurface?.kind === "preview" ? (
          <button
            type="button"
            aria-label="Close browser panel"
            onClick={onClosePanel}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </PreviewPanelShell>
  );
}
