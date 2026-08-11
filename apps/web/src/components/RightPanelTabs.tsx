import type { PreviewSessionSnapshot } from "@t3tools/contracts";
import {
  ClipboardList,
  FileDiff,
  Files,
  Globe2,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Plus,
  TerminalSquare,
  X,
} from "lucide-react";
import { type MouseEvent, type ReactNode, useState } from "react";

import type { RightPanelSurface } from "~/rightPanelStore";
import { cn } from "~/lib/utils";
import { PreviewPanelShell, type PreviewPanelMode } from "./preview/PreviewPanelShell";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "./ui/menu";

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
  readonly onCopyPath: (path: string) => void;
  readonly onAddBrowser: () => void;
  readonly onAddTerminal: () => void;
  readonly onAddFiles: () => void;
  readonly onAddDiff: () => void;
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
    case "file":
      return surface.relativePath.split("/").at(-1) ?? surface.relativePath;
    case "terminal":
      return terminalLabels[surface.resourceId] ?? "Terminal";
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
}: {
  readonly surface: RightPanelSurface;
  readonly sessions: Readonly<Record<string, PreviewSessionSnapshot>>;
}) {
  switch (surface.kind) {
    case "plan":
      return <ClipboardList className="size-3.5" />;
    case "diff":
      return <FileDiff className="size-3.5" />;
    case "files":
    case "file":
      return <Files className="size-3.5" />;
    case "terminal":
      return <TerminalSquare className="size-3.5" />;
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
  onCopyPath,
  onAddBrowser,
  onAddTerminal,
  onAddFiles,
  onAddDiff,
  maximized = false,
  onToggleMaximize,
  children,
}: Props) {
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
            const active = surface.id === activeSurfaceId;
            return (
              <div
                key={surface.id}
                className={cn(
                  "group flex h-6 min-w-20 max-w-40 shrink-0 items-center rounded-md border text-[11px]",
                  active
                    ? "border-border/70 bg-background text-foreground shadow-xs/5"
                    : "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <button
                  type="button"
                  title={title}
                  onClick={() => onActivate(surface)}
                  onAuxClick={(event) => closeOnMiddleClick(event, surface)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 pl-1.5"
                >
                  <Icon surface={surface} sessions={previewSessions} />
                  <span className="min-w-0 flex-1 truncate text-left">{title}</span>
                </button>
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
              <MenuItem onClick={onAddBrowser}>Browser</MenuItem>
              <MenuItem onClick={onAddTerminal}>Terminal</MenuItem>
              <MenuItem onClick={onAddFiles}>Files</MenuItem>
              <MenuItem onClick={onAddDiff}>Diff</MenuItem>
            </MenuPopup>
          </Menu>
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
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </PreviewPanelShell>
  );
}
