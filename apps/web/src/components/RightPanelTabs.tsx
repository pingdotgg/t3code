import type { PreviewSessionSnapshot } from "@t3tools/contracts";
import { ClipboardList, FileDiff, Globe2, Plus, TerminalSquare, X } from "lucide-react";
import { type ReactNode, useState } from "react";

import type { RightPanelSurface } from "~/rightPanelStore";
import { cn } from "~/lib/utils";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { faviconUrlForOrigin } from "~/lib/favicon";

import { PreviewPanelShell, type PreviewPanelMode } from "./preview/PreviewPanelShell";

interface RightPanelTabsProps {
  mode: PreviewPanelMode;
  surfaces: readonly RightPanelSurface[];
  activeSurfaceId: string;
  previewSessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  onActivate: (surface: RightPanelSurface) => void;
  onCloseSurface: (surface: RightPanelSurface) => void;
  onAddBrowser: () => void;
  onAddDiff: () => void;
  diffAvailable: boolean;
  children: ReactNode;
}

function surfaceTitle(
  surface: RightPanelSurface,
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>,
): string {
  switch (surface.kind) {
    case "diff":
      return "Diff";
    case "terminal":
      return "Terminal";
    case "plan":
      return "Plan";
    case "preview": {
      const snapshot = surface.resourceId ? sessions[surface.resourceId] : null;
      if (!snapshot || snapshot.navStatus._tag === "Idle") return "Browser";
      if (snapshot.navStatus.title.trim().length > 0) return snapshot.navStatus.title;
      try {
        return new URL(snapshot.navStatus.url).host || "Browser";
      } catch {
        return "Browser";
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
}: {
  surface: RightPanelSurface;
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>;
}) {
  switch (surface.kind) {
    case "preview": {
      const snapshot = surface.resourceId ? sessions[surface.resourceId] : null;
      const url = !snapshot || snapshot.navStatus._tag === "Idle" ? null : snapshot.navStatus.url;
      return <PreviewFavicon url={url} />;
    }
    case "diff":
      return <FileDiff className="size-3.5 shrink-0" />;
    case "terminal":
      return <TerminalSquare className="size-3.5 shrink-0" />;
    case "plan":
      return <ClipboardList className="size-3.5 shrink-0" />;
  }
}

export function RightPanelTabs(props: RightPanelTabsProps) {
  return (
    <PreviewPanelShell mode={props.mode}>
      <div className="flex h-10 shrink-0 items-center px-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {props.surfaces.map((surface) => {
            const active = surface.id === props.activeSurfaceId;
            const title = surfaceTitle(surface, props.previewSessions);
            return (
              <div
                key={surface.id}
                className={cn(
                  "group flex h-7 min-w-0 max-w-52 items-center gap-1.5 rounded-md px-2 text-sm",
                  active
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-1.5"
                  onClick={() => props.onActivate(surface)}
                  title={title}
                >
                  <SurfaceIcon surface={surface} sessions={props.previewSessions} />
                  <span className="truncate">{title}</span>
                </button>
                <button
                  type="button"
                  className="rounded p-0.5 opacity-0 hover:bg-muted group-hover:opacity-100 focus:opacity-100"
                  aria-label={`Close ${title}`}
                  onClick={() => props.onCloseSurface(surface)}
                >
                  <X className="size-3" />
                </button>
              </div>
            );
          })}
        </div>
        <Menu>
          <MenuTrigger
            className="relative ml-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Add panel surface"
          >
            <Plus className="size-4" />
          </MenuTrigger>
          <MenuPopup align="start" side="bottom" sideOffset={6} className="min-w-44">
            <MenuItem onClick={props.onAddBrowser}>
              <Globe2 />
              Browser
            </MenuItem>
            <MenuItem onClick={props.onAddDiff} disabled={!props.diffAvailable}>
              <FileDiff />
              Diff
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{props.children}</div>
    </PreviewPanelShell>
  );
}
