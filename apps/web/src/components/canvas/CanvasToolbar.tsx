import { T, msg, useGT, useMessages } from "gt-react";
import {
  Camera,
  Circle,
  Code,
  Ellipsis,
  Frame,
  Hand,
  MousePointer2,
  Pause,
  PictureInPicture2,
  Play,
  SlidersHorizontal,
  Square,
  Trash2,
  Type,
  type LucideIcon,
} from "lucide-react";
import { type ReactNode, useSyncExternalStore } from "react";

import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { definePluginComponent } from "~/plugins/features";

import type { CanvasTool } from "./canvasInteraction";

/** UI subscriptions expose zoom without exposing the renderer's large buffers. */
export interface CanvasZoomSource {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => number;
}

const TOOLS: ReadonlyArray<{
  tool: CanvasTool;
  label: string;
  shortcut: string;
  icon: LucideIcon;
}> = [
  {
    tool: "select",
    label: msg("Select", { $context: "canvas tool that selects layers" }),
    shortcut: "V",
    icon: MousePointer2,
  },
  {
    tool: "hand",
    label: msg("Hand", { $context: "canvas tool that pans the view" }),
    shortcut: "H",
    icon: Hand,
  },
  {
    tool: "frame",
    label: msg("Frame", { $context: "canvas tool that draws a frame" }),
    shortcut: "F",
    icon: Frame,
  },
  { tool: "rect", label: msg("Rectangle"), shortcut: "R", icon: Square },
  { tool: "ellipse", label: msg("Ellipse"), shortcut: "O", icon: Circle },
  {
    tool: "text",
    label: msg("Text", { $context: "canvas tool that adds a text layer" }),
    shortcut: "T",
    icon: Type,
  },
];

function ToolbarButton(props: {
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={props.pressed ? "secondary" : "ghost"}
            size="icon-xs"
            aria-label={props.label}
            {...(props.pressed === undefined ? {} : { "aria-pressed": props.pressed })}
            disabled={props.disabled}
            onClick={props.onClick}
            type="button"
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/** The canvas chrome row: same height and button sizes as the browser's. */
export const CanvasToolbar = definePluginComponent(
  "component:components/canvas/CanvasToolbar",
  PluginOriginalCanvasToolbar,
);

function PluginOriginalCanvasToolbar(props: {
  editable?: boolean;
  tool: CanvasTool;
  onToolChange: (tool: CanvasTool) => void;
  playing: boolean;
  onTogglePlaying: () => void;
  zoomSource: CanvasZoomSource;
  onZoomToFit: () => void;
  onExport: () => void;
  exportLabel: string;
  onScreenshot: () => void;
  screenshotLabel: string;
  screenshotDisabled: boolean;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onPopOut?: () => void;
  onDelete?: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  return (
    <div
      className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent"
      data-surface-subheader
    >
      <div className="flex items-center gap-0.5" role="group" aria-label={gt("Tools")}>
        {TOOLS.map(({ tool, label, shortcut, icon: Icon }) => (
          <ToolbarButton
            key={tool}
            label={gt("{label} ({shortcut})", { label: m(label), shortcut })}
            pressed={props.tool === tool}
            disabled={props.editable === false && tool !== "hand"}
            onClick={() => props.onToolChange(tool)}
          >
            <Icon />
          </ToolbarButton>
        ))}
      </div>
      <div className="min-w-0 flex-1" />
      <ToolbarButton
        label={props.playing ? gt("Pause animations") : gt("Play animations")}
        pressed={props.playing}
        onClick={props.onTogglePlaying}
      >
        {props.playing ? <Pause /> : <Play />}
      </ToolbarButton>
      <ZoomButton zoomSource={props.zoomSource} onZoomToFit={props.onZoomToFit} />
      <ToolbarButton label={props.exportLabel} onClick={props.onExport}>
        <Code />
      </ToolbarButton>
      <ToolbarButton
        label={props.screenshotLabel}
        disabled={props.screenshotDisabled}
        onClick={props.onScreenshot}
      >
        <Camera />
      </ToolbarButton>
      <ToolbarButton
        label={props.inspectorOpen ? gt("Hide inspector") : gt("Show inspector")}
        pressed={props.inspectorOpen}
        onClick={props.onToggleInspector}
      >
        <SlidersHorizontal />
      </ToolbarButton>
      {props.onPopOut ? (
        <ToolbarButton
          label={gt("Float canvas over chat")}
          disabled={props.editable === false}
          onClick={props.onPopOut}
        >
          <PictureInPicture2 />
        </ToolbarButton>
      ) : null}
      {props.onDelete ? (
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={gt("More canvas actions")}
                type="button"
              />
            }
          >
            <Ellipsis />
          </MenuTrigger>
          <MenuPopup align="end" side="bottom" sideOffset={6}>
            <MenuItem
              variant="destructive"
              disabled={props.editable === false}
              onClick={props.onDelete}
            >
              <Trash2 />
              <T>Delete canvas</T>
            </MenuItem>
          </MenuPopup>
        </Menu>
      ) : null}
    </div>
  );
}

/** Live zoom percent; renders on its own so zooming never re-renders the toolbar. */
function ZoomButton(props: { zoomSource: CanvasZoomSource; onZoomToFit: () => void }) {
  const { zoomSource } = props;
  const gt = useGT();
  const percent = useSyncExternalStore(zoomSource.subscribe, zoomSource.getSnapshot);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            aria-label={gt("Zoom to fit")}
            onClick={props.onZoomToFit}
            type="button"
          />
        }
      >
        <span className="tabular-nums">{percent < 1 ? "<1" : percent}%</span>
      </TooltipTrigger>
      <TooltipPopup>{gt("Zoom to fit ({shortcut})", { shortcut: "Shift+1" })}</TooltipPopup>
    </Tooltip>
  );
}
