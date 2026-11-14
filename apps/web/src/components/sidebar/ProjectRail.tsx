import {
  DndContext,
  type DragEndEvent,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { EyeIcon, EyeOffIcon, LayersIcon } from "lucide-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import * as Schema from "effect/Schema";
import type { MouseEvent, ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useNowMinute } from "../../hooks/useNowMinute";
import { deriveProjectIdentity } from "../../projectIdentity";
import { useUiStateStore } from "../../uiStateStore";
import { resolveSidebarFolderDot, resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { ProjectFavicon } from "../ProjectFavicon";
import { ProjectMonogram } from "../ProjectMonogram";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  type ProjectRailDot,
  type ProjectRailTile,
  resolveProjectRailTileStates,
} from "./ProjectRail.logic";
import { FOLDER_DOT_CLASS_NAME, FOLDER_DOT_LABEL } from "./SidebarProjectFolderHeader";

const HIDE_IDLE_KEY = "t3code:sidebar:project-rail-hide-idle";

/**
 * A column of project and folder tiles beside the thread list. It is another
 * view of the sidebar's filter: a tile shows only its threads, Shift or Ctrl
 * adds it to what is shown, and the top tile shows everything.
 * Tile state reads the minute clock here, so only the rail re-renders on it.
 */
export function ProjectRail(props: {
  tiles: readonly ProjectRailTile[];
  threads: readonly EnvironmentThreadShell[];
  selectedKeys: readonly string[];
  onSelectAll: () => void;
  onSelect: (key: string, additive: boolean) => void;
  onMove: (activeKey: string, overKey: string) => void;
}) {
  const { selectedKeys } = props;
  const nowMinute = useNowMinute();
  const localLastVisitedAtById = useUiStateStore((store) => store.threadLastVisitedAtById);
  const [hideIdle, setHideIdle] = useLocalStorage(HIDE_IDLE_KEY, false, Schema.Boolean);
  const threads = props.threads.map((thread) => ({
    ...thread,
    lastVisitedAt: resolveThreadLastVisitedAt(
      thread.lastVisitedAt,
      localLastVisitedAtById[scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))],
    ),
  }));
  const states = resolveProjectRailTileStates(props.tiles, threads, `${nowMinute}:00.000Z`);
  const allDot = resolveSidebarFolderDot(threads);
  // A shown tile stays, so the way back out of its filter stays on the rail.
  const tiles = props.tiles.filter(
    (tile) => !hideIdle || !states.get(tile.key)?.idle || selectedKeys.includes(tile.key),
  );
  // A finger holds before a tile lifts, so a swipe still scrolls the rail.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 350, tolerance: 6 } }),
  );
  const onDragEnd = (event: DragEndEvent) => {
    if (event.over === null || event.active.id === event.over.id) return;
    props.onMove(String(event.active.id), String(event.over.id));
  };
  const hideLabel = hideIdle ? "Show idle projects" : "Hide idle projects";
  return (
    <nav
      aria-label="Projects"
      className="flex w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-sidebar-border py-2 [scrollbar-width:none]"
    >
      <RailTileButton
        label="All projects"
        selected={selectedKeys.length === 0}
        dot={allDot}
        onClick={() => props.onSelectAll()}
      >
        <LayersIcon className="size-4.5" />
      </RailTileButton>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={hideLabel}
              aria-pressed={hideIdle}
              onClick={() => setHideIdle(!hideIdle)}
            />
          }
        >
          {hideIdle ? <EyeOffIcon aria-hidden /> : <EyeIcon aria-hidden />}
        </TooltipTrigger>
        <TooltipPopup side="right">{hideLabel}</TooltipPopup>
      </Tooltip>
      <span aria-hidden className="my-1 h-px w-6 shrink-0 bg-sidebar-border" />
      <DndContext
        sensors={sensors}
        modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
        onDragEnd={onDragEnd}
      >
        <SortableContext
          items={tiles.map((tile) => tile.key)}
          strategy={verticalListSortingStrategy}
        >
          {tiles.map((tile) => (
            <SortableRailTile
              key={tile.key}
              tile={tile}
              dot={states.get(tile.key)?.dot ?? null}
              idle={states.get(tile.key)?.idle ?? false}
              selected={selectedKeys.includes(tile.key)}
              onSelect={props.onSelect}
            />
          ))}
        </SortableContext>
      </DndContext>
    </nav>
  );
}

function SortableRailTile(props: {
  tile: ProjectRailTile;
  dot: ProjectRailDot;
  idle: boolean;
  selected: boolean;
  onSelect: (key: string, additive: boolean) => void;
}) {
  const { tile, dot, idle } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tile.key,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("shrink-0", isDragging && "z-10 opacity-80")}
      {...attributes}
      {...listeners}
      // The tile button inside takes focus; the sortable wrapper stays out of tab order.
      tabIndex={-1}
    >
      <RailTileButton
        label={tile.kind === "project" ? tile.group.displayName : tile.tag}
        detail={tile.kind === "project" ? tile.group.workspaceRoot : "Folder"}
        selected={props.selected}
        quiet={idle}
        dot={dot}
        onClick={(event) =>
          props.onSelect(tile.key, event.shiftKey || event.ctrlKey || event.metaKey)
        }
      >
        {tile.kind === "project" ? (
          <ProjectFavicon project={tile.group} className="size-5" />
        ) : (
          <FolderMonogram tag={tile.tag} />
        )}
      </RailTileButton>
    </div>
  );
}

function FolderMonogram(props: { tag: string }) {
  const identity = deriveProjectIdentity(props.tag);
  return <ProjectMonogram text={identity.monogram} color={identity.color} className="size-5" />;
}

function RailTileButton(props: {
  label: string;
  detail?: string;
  selected: boolean;
  quiet?: boolean;
  dot: ProjectRailDot;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`${props.label}${props.dot ? FOLDER_DOT_LABEL[props.dot] : ""}`}
            aria-pressed={props.selected}
            onClick={props.onClick}
            className={cn(
              "relative flex size-9 cursor-pointer items-center justify-center rounded-lg text-sidebar-foreground/80 outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              props.selected && "bg-sidebar-row-hover text-sidebar-foreground",
              props.quiet && !props.selected && "opacity-45 hover:opacity-100",
            )}
          />
        }
      >
        {props.selected ? (
          <span
            aria-hidden
            className="absolute top-1.5 -left-1.5 h-6 w-1 rounded-r-full bg-sidebar-foreground"
          />
        ) : null}
        {props.children}
        {props.dot ? (
          <span
            aria-hidden
            className={cn(
              "absolute top-1 right-1 size-2 rounded-full ring-2 ring-sidebar",
              FOLDER_DOT_CLASS_NAME[props.dot],
            )}
          />
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="right">
        <div className="font-medium">{props.label}</div>
        {props.detail ? <div className="text-xs text-muted-foreground">{props.detail}</div> : null}
      </TooltipPopup>
    </Tooltip>
  );
}
