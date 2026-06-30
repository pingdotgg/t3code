import { useDraggable, useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { GitBranchIcon, XIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

export type LaneRoutingKind = "success" | "failure" | "blocked";

export interface LaneRoutingDrop {
  readonly laneKey: string;
  readonly kind: LaneRoutingKind;
  readonly stepKey?: string;
  readonly targetLaneKey: string | undefined;
}

export interface RouteDragData {
  readonly laneKey: string;
  readonly kind: LaneRoutingKind;
  readonly stepKey?: string;
}

export interface LaneDropData {
  readonly laneKey?: string;
  readonly clear?: boolean;
}

export const routeDndId = (parts: readonly [string, ...string[]]): string => JSON.stringify(parts);

export const laneRouteDragId = (laneKey: string, kind: LaneRoutingKind): string =>
  routeDndId(["lane-route", laneKey, kind]);

export const laneDropId = (laneKey: string): string => routeDndId(["lane-drop", laneKey]);

export const laneRouteClearDropId = routeDndId(["lane-route-clear"]);

export interface LaneMoveDragData {
  readonly type: "lane-move";
  readonly laneKey: string;
}

export const laneMoveDragId = (laneKey: string): string => routeDndId(["lane-move", laneKey]);

export const readLaneMoveDragData = (value: unknown): LaneMoveDragData | null => {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as Partial<LaneMoveDragData>;
  return data.type === "lane-move" && typeof data.laneKey === "string"
    ? { type: "lane-move", laneKey: data.laneKey }
    : null;
};

const routeKinds = ["success", "failure", "blocked"] as const satisfies readonly LaneRoutingKind[];

/**
 * Route-kind color language shared by the routing edges and the connection handles:
 * success = green, blocked = yellow, failure = red.
 */
export const ROUTE_KIND_HANDLE_CLASS = {
  success: "border-success/70 text-success",
  failure: "border-destructive/70 text-destructive",
  blocked: "border-warning/70 text-warning",
} satisfies Record<LaneRoutingKind, string>;

export const ROUTE_KIND_STROKE_CLASS = {
  success: "text-success",
  failure: "text-destructive",
  blocked: "text-warning",
} satisfies Record<LaneRoutingKind, string>;

export const ROUTE_KIND_LABEL_FILL_CLASS = {
  success: "fill-success",
  failure: "fill-destructive",
  blocked: "fill-warning",
} satisfies Record<LaneRoutingKind, string>;

export const resolveLaneRoutingDrop = (
  laneKeys: ReadonlyArray<string>,
  activeData: unknown,
  overData: unknown,
): LaneRoutingDrop | null => {
  const active = readRouteDragData(activeData);
  if (!active || !laneKeys.includes(active.laneKey) || !overData) {
    return null;
  }

  const drop = readLaneDropData(overData);
  if (drop?.clear) {
    return { ...active, targetLaneKey: undefined };
  }

  const targetLaneKey = drop?.laneKey;
  if (!targetLaneKey || !laneKeys.includes(targetLaneKey)) {
    return null;
  }

  return { ...active, targetLaneKey };
};

export function LaneRouteHandle({
  laneKey,
  laneName,
  kind,
  top,
  hasRoute,
  disabled = false,
  onClear,
}: {
  readonly laneKey: string;
  readonly laneName: string;
  readonly kind: LaneRoutingKind;
  readonly top: number;
  readonly hasRoute: boolean;
  readonly disabled?: boolean;
  readonly onClear: () => void;
}) {
  const { attributes, isDragging, listeners, setNodeRef, transform } = useDraggable({
    id: laneRouteDragId(laneKey, kind),
    data: { laneKey, kind } satisfies RouteDragData,
    disabled,
  });

  return (
    <div
      className="absolute -right-4 z-10 flex items-center gap-1"
      style={{ top }}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        ref={setNodeRef}
        id={`lane-${laneKey}-on-${kind}`}
        type="button"
        data-canvas-anchor
        aria-label={`Drag ${kind} route from ${laneName}`}
        disabled={disabled}
        className={cn(
          "size-5 rounded-full border border-border bg-background text-muted-foreground shadow-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
          hasRoute && ROUTE_KIND_HANDLE_CLASS[kind],
          isDragging && "opacity-80",
        )}
        style={{ transform: CSS.Translate.toString(transform) }}
        {...attributes}
        {...listeners}
      >
        <GitBranchIcon className="mx-auto size-3" />
      </button>
      {hasRoute ? (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Clear ${kind} route from ${laneName}`}
          disabled={disabled}
          onClick={(event) => {
            event.stopPropagation();
            onClear();
          }}
        >
          <XIcon className="size-3" />
        </Button>
      ) : null}
    </div>
  );
}

export function useLaneDropTarget(laneKey: string) {
  return useDroppable({ id: laneDropId(laneKey), data: { laneKey } satisfies LaneDropData });
}

export function LaneRouteClearDropZone() {
  const { isOver, setNodeRef } = useDroppable({
    id: laneRouteClearDropId,
    data: { clear: true } satisfies LaneDropData,
  });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "absolute right-0 top-0 z-10 rounded-md border border-dashed border-border/70 bg-background/90 px-2 py-1 text-[11px] text-muted-foreground shadow-xs",
        isOver && "border-destructive/70 text-destructive",
      )}
    >
      Drop route here to clear
    </div>
  );
}

function isLaneRoutingKind(value: string | undefined): value is LaneRoutingKind {
  return routeKinds.some((kind) => kind === value);
}

function readRouteDragData(value: unknown): RouteDragData | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as Partial<RouteDragData>;
  if (typeof data.laneKey !== "string" || !isLaneRoutingKind(data.kind)) {
    return null;
  }
  if (data.stepKey !== undefined && typeof data.stepKey !== "string") {
    return null;
  }
  return data.stepKey === undefined
    ? { laneKey: data.laneKey, kind: data.kind }
    : { laneKey: data.laneKey, kind: data.kind, stepKey: data.stepKey };
}

function readLaneDropData(value: unknown): LaneDropData | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as Partial<LaneDropData>;
  if (data.clear) {
    return { clear: true };
  }
  return typeof data.laneKey === "string" ? { laneKey: data.laneKey } : null;
}
