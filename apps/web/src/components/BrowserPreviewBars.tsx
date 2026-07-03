import type {
  PreviewSessionSnapshot,
  PreviewViewportSetting,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  LoaderIcon,
  MonitorIcon,
  SearchIcon,
  SmartphoneIcon,
  TabletIcon,
  XIcon,
} from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { activatePreviewTab, getPreviewSnapshotTitle } from "~/previewStateStore";
import { Button } from "./ui/button";

export const PREVIEW_DEVICE_PRESETS = [
  { id: "fill", label: "Fill", icon: MonitorIcon, viewport: { _tag: "fill" } },
  {
    id: "mobile",
    label: "390 x 844",
    icon: SmartphoneIcon,
    viewport: { _tag: "freeform", width: 390, height: 844 },
  },
  {
    id: "tablet",
    label: "768 x 1024",
    icon: TabletIcon,
    viewport: { _tag: "freeform", width: 768, height: 1024 },
  },
  {
    id: "desktop",
    label: "1440 x 900",
    icon: MonitorIcon,
    viewport: { _tag: "freeform", width: 1440, height: 900 },
  },
] as const satisfies ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly icon: typeof MonitorIcon;
  readonly viewport: PreviewViewportSetting;
}>;

export const PreviewTabStrip = memo(function PreviewTabStrip({
  threadRef,
  sessions,
  activeTabId,
  onCloseTab,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly sessions: readonly PreviewSessionSnapshot[];
  readonly activeTabId: string | undefined;
  readonly onCloseTab: (tabId: string) => void;
}) {
  if (sessions.length === 0) return null;
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2">
      {sessions.map((session) => {
        const title = getPreviewSnapshotTitle(session);
        return (
          <div
            key={session.tabId}
            className={cn(
              "flex min-w-0 shrink-0 items-center rounded-md border text-xs",
              session.tabId === activeTabId
                ? "border-border bg-muted text-foreground"
                : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            <button
              type="button"
              className="max-w-44 truncate px-2 py-1.5"
              title={title}
              onClick={() => activatePreviewTab(threadRef, session.tabId)}
            >
              {title}
            </button>
            <button
              type="button"
              className="rounded-r-md px-1.5 py-1.5 hover:bg-background/80"
              aria-label={`Close ${title}`}
              onClick={() => onCloseTab(session.tabId)}
            >
              <XIcon className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
});

export const PreviewDeviceBar = memo(function PreviewDeviceBar({
  viewport,
  isDiscoveringServers,
  onResize,
  onDiscoverServers,
}: {
  readonly viewport: PreviewViewportSetting | undefined;
  readonly isDiscoveringServers: boolean;
  readonly onResize: (viewport: PreviewViewportSetting) => void;
  readonly onDiscoverServers: () => void;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2">
      {PREVIEW_DEVICE_PRESETS.map((preset) => {
        const Icon = preset.icon;
        const selected =
          (viewport ?? { _tag: "fill" })._tag === preset.viewport._tag &&
          (preset.viewport._tag === "fill" ||
            (viewport?._tag === "freeform" &&
              viewport.width === preset.viewport.width &&
              viewport.height === preset.viewport.height));
        return (
          <Button
            key={preset.id}
            type="button"
            variant={selected ? "secondary" : "ghost"}
            size="sm"
            className="h-7 shrink-0 gap-1 px-2 text-xs"
            onClick={() => onResize(preset.viewport)}
            title={preset.label}
          >
            <Icon className="size-3" />
            {preset.label}
          </Button>
        );
      })}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="ml-auto size-7 shrink-0"
        onClick={onDiscoverServers}
        aria-label="Discover local servers"
      >
        {isDiscoveringServers ? (
          <LoaderIcon className="size-3 animate-spin" />
        ) : (
          <SearchIcon className="size-3" />
        )}
      </Button>
    </div>
  );
});
