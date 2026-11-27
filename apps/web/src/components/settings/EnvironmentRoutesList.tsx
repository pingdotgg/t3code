import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  canRemoveRoute,
  type ConnectionRoute,
  connectionRouteAddress,
  connectionRouteId,
  connectionRouteLabelText,
  connectionRoutes,
  isLearned,
  pendingRouteOrder,
} from "@t3tools/client-runtime/connection";
import { GripVerticalIcon, PlusIcon, XIcon } from "lucide-react";
import { T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { environmentCatalog } from "~/connection/catalog";
import { cn } from "~/lib/utils";
import type { EnvironmentPresentation } from "~/state/environments";
import { usePreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

export function EnvironmentRoutesList({
  environment,
  onAddRoute,
}: {
  readonly environment: EnvironmentPresentation;
  readonly onAddRoute: () => void;
}) {
  const saved = connectionRoutes(environment.entry);
  const savedIds = saved.map((route) => connectionRouteId(route.target));
  const [pending, setPending] = useState<ReadonlyArray<string> | null>(null);
  const shownPending = pendingRouteOrder(pending, savedIds);
  // Dropped during render so a stale order never outlives the save it was for.
  if (pending !== null && shownPending === null) setPending(null);
  const order: Array<string> = shownPending === null ? savedIds : [...shownPending];
  const byId = new Map(saved.map((route) => [connectionRouteId(route.target), route]));
  const routes = order.flatMap((id) => byId.get(id) ?? []);

  const gt = useGT();
  const messages = useMessages();
  const prepared = usePreparedConnection(environment.environmentId);
  const activeRouteId =
    prepared._tag === "Some" && environment.connection.phase === "connected"
      ? connectionRouteId(prepared.value.target)
      : null;
  const reorder = useAtomCommand(environmentCatalog.reorderRoutes, "Reorder routes");
  const removeRoute = useAtomCommand(environmentCatalog.removeRoute, "Remove route");
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const confirmRemove = async (route: ConnectionRoute) => {
    const address = connectionRouteAddress(route);
    const confirmed = await requestConfirmDialog(
      address === null
        ? gt("Remove {route} route?", { route: connectionRouteLabelText(route, messages) })
        : gt("Remove {route} route?\n{address}", {
            route: connectionRouteLabelText(route, messages),
            address,
          }),
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    await removeRoute({
      environmentId: environment.environmentId,
      routeId: connectionRouteId(route.target),
    });
  };

  const handleDragEnd = (event: DragEndEvent) => {
    if (event.over === null || event.active.id === event.over.id) return;
    const next = arrayMove(
      order,
      order.indexOf(String(event.active.id)),
      order.indexOf(String(event.over.id)),
    );
    setPending(next);
    void reorder({ environmentId: environment.environmentId, routeIds: next }).then((result) => {
      if (result._tag === "Failure") setPending(null);
    });
  };

  return (
    <div className="mt-2 border-t border-border/50 py-2">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis, restrictToParentElement]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={order} strategy={verticalListSortingStrategy}>
          <ol
            aria-label={gt("Routes to {environment}, preferred first", {
              environment: environment.label,
            })}
          >
            {routes.map((route, index) => (
              <SortableRouteRow
                key={connectionRouteId(route.target)}
                route={route}
                position={index + 1}
                inUse={connectionRouteId(route.target) === activeRouteId}
                refused={environment.refusedRouteIds.includes(connectionRouteId(route.target))}
                removable={canRemoveRoute(routes, route)}
                onRemove={() => void confirmRemove(route)}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
      <div className="-ml-1.5 pt-1">
        <Button size="xs" variant="ghost-muted" onClick={onAddRoute}>
          <PlusIcon className="size-3" />
          <T>Add route</T>
        </Button>
      </div>
    </div>
  );
}

function SortableRouteRow({
  route,
  position,
  inUse,
  refused,
  removable,
  onRemove,
}: {
  readonly route: ConnectionRoute;
  readonly position: number;
  readonly inUse: boolean;
  readonly refused: boolean;
  readonly removable: boolean;
  readonly onRemove: () => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const id = connectionRouteId(route.target);
  const label = connectionRouteLabelText(route, messages);
  const address = connectionRouteAddress(route);
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "flex items-center gap-2 py-2",
        isDragging && "relative z-10 rounded-md bg-background shadow-md",
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-meta text-foreground">
          {label}
          {inUse ? (
            <span className="rounded-sm bg-success/12 px-1 text-caption text-success-foreground">
              <T>In use</T>
            </span>
          ) : null}
          {refused ? (
            <span className="rounded-sm bg-destructive/8 px-1 text-caption text-destructive-foreground">
              <T>Sign-in refused</T>
            </span>
          ) : null}
        </p>
        {address !== null ? (
          <SharedTooltipTrigger
            render={<p tabIndex={0} className="truncate text-meta text-muted-foreground" />}
            label={isLearned(route) ? gt("Found automatically") : address}
          >
            {address}
          </SharedTooltipTrigger>
        ) : null}
        {refused && address !== null ? (
          <p className="text-meta text-muted-foreground">
            <T>The host refused this device's sign-in. Pair this address again with Add route.</T>
          </p>
        ) : null}
      </div>
      <Button
        size="icon-xs"
        variant="ghost-muted"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={gt("Reorder {route}, position {position}", { route: label, position })}
        className="cursor-grab touch-none active:cursor-grabbing"
      >
        <GripVerticalIcon className="size-3.5" />
      </Button>
      {removable ? (
        <SharedTooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost-muted"
              size="icon-xs"
              aria-label={gt("Remove {route} route", { route: label })}
              onClick={onRemove}
            />
          }
          label={
            <>
              <T>Remove route</T>
            </>
          }
        >
          <XIcon className="size-3" />
        </SharedTooltipTrigger>
      ) : null}
    </li>
  );
}
