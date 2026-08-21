import type { ReactNode } from "react";

import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

import { PreviewPanelShell, type PreviewPanelMode } from "../preview/PreviewPanelShell";

export function SourceControlPanelShell(props: {
  mode: PreviewPanelMode;
  maximized?: boolean;
  layoutControls?: ReactNode;
  children: ReactNode;
}) {
  const ownsDesktopTitleBar = isElectron && props.mode === "inline";

  return (
    <PreviewPanelShell
      mode={props.mode}
      widthStorageKey="t3code:source-control-panel-width"
      defaultWidth={420}
      {...(props.maximized !== undefined ? { maximized: props.maximized } : {})}
    >
      <div
        className="flex min-h-0 flex-1 flex-col bg-sidebar surface-grain text-sidebar-foreground"
        data-app-sidebar=""
        data-sidebar-version="v2"
        data-source-control-panel-surface
      >
        <div
          className={cn(
            "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1 pl-2",
            props.mode !== "inline" && "[--workspace-topbar-height:--spacing(11)]",
            props.mode === "inline" ? "pr-32" : "pr-3",
            ownsDesktopTitleBar && "drag-region",
            ownsDesktopTitleBar && "wco:pr-[calc(var(--workspace-native-controls-inset)+8rem)]",
            props.mode === "inline" && props.maximized && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
          data-source-control-panel-titlebar
        >
          <span className="truncate px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-sidebar-muted-foreground">
            Source Control
          </span>
          {props.layoutControls ? (
            <div className="ml-auto h-full">{props.layoutControls}</div>
          ) : null}
        </div>
        <div className="flex min-h-0 flex-1 flex-col" data-source-control-panel-content>
          {props.children}
        </div>
      </div>
    </PreviewPanelShell>
  );
}
