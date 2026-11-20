import { RegistryContext } from "@effect/atom-react";
import { useContext, useState } from "react";

import { STAGE_LABEL } from "../domain/ticket";
import type { BoardModel } from "../state/boardModel";
import { type Peek, saveFrameOrder } from "../state/boardUi";
import { AgentCard } from "./AgentCard";
import {
  clampDrag,
  edgePath,
  type FrameBox,
  type LaneBox,
  type LaneId,
  type Layout,
  LANE_HEAD,
  reorderByDrag,
  UNASSIGNED_HEAD,
  UNASSIGNED_KEY,
  CARD_GAP,
  FRAME_PAD,
} from "./layout";
import { TicketFrame } from "./TicketFrame";

const LABEL = {
  for_you: "For you",
  ...STAGE_LABEL,
  unassigned: "Unassigned",
} as const satisfies Record<LaneId, string>;

const LANE_TONE = {
  for_you: "bg-amber-500 text-black",
  planned: "bg-zinc-600 text-white",
  building: "bg-blue-600 text-white",
  reviewing: "bg-violet-600 text-white",
  verifying: "bg-cyan-600 text-white",
  pr: "bg-indigo-600 text-white",
  awaiting_approval: "bg-orange-600 text-white",
  merged: "bg-emerald-600 text-white",
  off_path: "bg-zinc-500 text-white",
  unassigned: "bg-red-600 text-white",
} as const satisfies Record<LaneId, string>;

/** Every lane on the canvas, its ticket frames with their agents, and the edges between dependent tickets. */
export function Lanes({
  layout,
  model,
  boardId,
  forYouOpen,
  peek,
  onPeek,
}: {
  layout: Layout;
  model: BoardModel;
  boardId: string;
  forYouOpen: number;
  peek: Peek | null;
  onPeek: (peek: Peek) => void;
}) {
  const registry = useContext(RegistryContext);
  const [drag, setDrag] = useState<{ key: string; dy: number } | null>(null);
  const views = new Map(
    Object.values(model.lanes)
      .flat()
      .map((view) => [view.ticket.key, view]),
  );
  const boxes = new Map(layout.lanes.flatMap((lane) => lane.frames).map((box) => [box.key, box]));
  // The frame under the pointer moves, and its edges follow.
  const moved = (box: FrameBox): FrameBox =>
    drag?.key === box.key ? { ...box, y: box.y + drag.dy } : box;

  const drop = (lane: LaneBox) => {
    if (drag === null) return;
    const order = reorderByDrag(lane, drag.key, drag.dy);
    setDrag(null);
    void saveFrameOrder(registry, boardId, lane.id, order);
  };

  return (
    <>
      <svg
        aria-hidden
        className="pointer-events-none absolute top-0 left-0 overflow-visible"
        width={layout.content.width}
        height={layout.content.height}
      >
        <defs>
          <marker
            id="edge-arrow"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto"
          >
            <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--color-muted)" />
          </marker>
        </defs>
        {layout.edges.map((edge) => {
          const from = boxes.get(edge.from);
          const to = boxes.get(edge.to);
          if (from === undefined || to === undefined) return null;
          return (
            <path
              key={`${edge.from}>${edge.to}`}
              data-edge={`${edge.from}>${edge.to}`}
              d={edgePath(moved(from), moved(to))}
              fill="none"
              stroke="var(--color-muted)"
              strokeWidth={1.5}
              markerEnd="url(#edge-arrow)"
            />
          );
        })}
      </svg>
      {layout.lanes.map((lane) => (
        <section
          key={lane.id}
          aria-label={`${LABEL[lane.id]} lane`}
          data-testid="lane"
          data-lane={lane.id}
          className="absolute rounded-xl border border-dashed border-line"
          style={{ left: lane.x, top: lane.y, width: lane.width, height: lane.height }}
        >
          <header className="flex items-center gap-1.5 px-3" style={{ height: LANE_HEAD }}>
            <span
              className={`rounded-md px-2 text-[11px] leading-5 font-semibold ${LANE_TONE[lane.id]}`}
            >
              {LABEL[lane.id]}
            </span>
            <span className="text-[11px] text-faint">{laneCount(lane, model, forYouOpen)}</span>
          </header>
          {lane.id === "for_you" && (
            <p className="px-3 text-[11px] text-faint">
              {forYouOpen === 0 ? "Nothing needs you" : `${forYouOpen} open`}
            </p>
          )}
        </section>
      ))}
      {layout.lanes.flatMap((lane) =>
        lane.frames.map((box) => {
          if (box.key === UNASSIGNED_KEY) {
            return (
              <section
                key={box.key}
                aria-label="Unassigned agents"
                data-testid="unassigned"
                className="absolute rounded-lg border border-line bg-panel shadow-panel"
                style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
              >
                <p
                  className="px-2.5 pt-2 text-[11px] text-faint"
                  style={{ height: UNASSIGNED_HEAD }}
                >
                  Started with no ticket
                </p>
                <div className="flex flex-col" style={{ gap: CARD_GAP, padding: FRAME_PAD }}>
                  {model.unassigned.map((agent) => (
                    <AgentCard
                      key={agent.threadId}
                      agent={agent}
                      selected={agent.threadId === peek?.threadId}
                      onOpen={() => onPeek({ threadId: agent.threadId, ticketKey: null })}
                    />
                  ))}
                </div>
              </section>
            );
          }
          const view = views.get(box.key);
          if (view === undefined) return null;
          return (
            <TicketFrame
              key={box.key}
              view={view}
              box={box}
              offset={drag?.key === box.key ? drag.dy : 0}
              selectedThreadId={peek?.threadId ?? null}
              onDrag={(dy) => setDrag({ key: box.key, dy: clampDrag(lane, box, dy) })}
              onDrop={() => drop(lane)}
              onOpen={(threadId) => onPeek({ threadId, ticketKey: box.key })}
            />
          );
        }),
      )}
    </>
  );
}

function laneCount(lane: LaneBox, model: BoardModel, forYouOpen: number): number {
  if (lane.id === "for_you") return forYouOpen;
  return lane.id === "unassigned" ? model.unassigned.length : model.lanes[lane.id].length;
}
