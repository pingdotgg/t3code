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
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "./ui/menu";

type Props = {
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
    <section
      className={cn(
        "flex min-h-0 w-[min(42vw,36rem)] min-w-80 flex-col border-l border-border bg-card max-[980px]:w-full max-[980px]:min-w-0",
        maximized && "w-full max-w-none",
      )}
      data-right-panel-maximized={maximized ? "true" : "false"}
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {surfaces.map((surface) => {
            const title = titleFor(surface, previewSessions, terminalLabels);
            const active = surface.id === activeSurfaceId;
            return (
              <div
                key={surface.id}
                className={cn(
                  "group flex h-7 min-w-24 max-w-44 shrink-0 items-center rounded text-xs",
                  active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60",
                )}
              >
                <button
                  type="button"
                  title={title}
                  onClick={() => onActivate(surface)}
                  onAuxClick={(event) => closeOnMiddleClick(event, surface)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-2"
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
                        className="rounded p-1 opacity-0 hover:bg-background/60 group-hover:opacity-100 focus:opacity-100"
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
                  className="rounded p-1 opacity-0 hover:bg-background/60 group-hover:opacity-100 focus:opacity-100"
                >
                  <X className="size-3" />
                </button>
              </div>
            );
          })}
        </div>
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                aria-label="Add surface"
                className="rounded p-1 hover:bg-accent"
              >
                <Plus className="size-4" />
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
        {onToggleMaximize ? (
          <button
            type="button"
            aria-label={maximized ? "Restore panel size" : "Maximize panel"}
            onClick={onToggleMaximize}
            className="rounded p-1 hover:bg-accent"
          >
            {maximized ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}
