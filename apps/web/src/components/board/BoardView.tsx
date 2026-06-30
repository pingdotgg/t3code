import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";

import { LaneColumn, type LaneColumnView } from "./LaneColumn";

export interface BoardViewTicket {
  readonly ticketId: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly currentLaneKey: string;
  readonly status: string;
  readonly queuedAt?: string | undefined;
  readonly totalTokens?: number | undefined;
  readonly totalDurationMs?: number | undefined;
  readonly pr?:
    | {
        readonly number: number;
        readonly url: string;
        readonly state: "open" | "merged" | "closed";
        readonly ciState?: "pending" | "success" | "failure" | undefined;
      }
    | undefined;
}

export interface BoardViewState {
  readonly lanes: ReadonlyArray<LaneColumnView>;
  readonly ticketIds: ReadonlyArray<string>;
  readonly ticketById: Record<string, BoardViewTicket>;
}

export function resolveBoardDropLaneKey(
  state: BoardViewState,
  ticketId: string,
  overId: string | null,
): string | null {
  if (!overId) {
    return null;
  }

  const targetLaneKey = overId.startsWith("lane:")
    ? overId.slice("lane:".length)
    : state.ticketById[overId]?.currentLaneKey;
  const currentLaneKey = state.ticketById[ticketId]?.currentLaneKey;

  if (!targetLaneKey || targetLaneKey === currentLaneKey) {
    return null;
  }

  return targetLaneKey;
}

const ticketsForIds = (
  state: BoardViewState,
  ticketIds: ReadonlyArray<string>,
): ReadonlyArray<BoardViewTicket> =>
  ticketIds
    .map((ticketId) => state.ticketById[ticketId])
    .filter((ticket): ticket is BoardViewTicket => ticket !== undefined);

export function BoardView({
  state,
  onMove,
  onOpen,
}: {
  readonly state: BoardViewState;
  readonly onMove: (ticketId: string, toLane: string) => void;
  readonly onOpen: (id: string) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );
  const handleDragEnd = (event: DragEndEvent) => {
    const ticketId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    const toLane = resolveBoardDropLaneKey(state, ticketId, overId);

    if (toLane) {
      onMove(ticketId, toLane);
    }
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={handleDragEnd}>
      <div className="flex h-full min-h-0 gap-4 overflow-x-auto overflow-y-hidden px-4 py-3">
        {state.lanes.map((lane) => (
          <LaneColumn
            key={lane.key}
            lane={lane}
            onOpen={onOpen}
            admittedTickets={ticketsForIds(state, lane.admittedTicketIds)}
            queuedTickets={ticketsForIds(state, lane.queuedTicketIds)}
          />
        ))}
      </div>
    </DndContext>
  );
}
