import { ArrowRight, GitBranch, RotateCcw } from "lucide-react";
import { useRef } from "react";

import type { Ticket } from "../domain/ticket";
import type { TicketView } from "../state/boardModel";
import { AgentCard } from "./AgentCard";
import { CARD_GAP, FRAME_PAD, type FrameBox, hasChips } from "./layout";
import { useViewScale } from "./Viewport";

const DRAG_THRESHOLD_PX = 4;

const chip =
  "inline-flex max-w-full items-center gap-1 rounded border border-line px-1.5 text-[10px] leading-4 text-muted";

type Verdict = NonNullable<Ticket["verdicts"]>[number];

/** The review's findings, worst first. A review with none is clean. */
function verdictText(verdict: Verdict) {
  const counts = (["p0", "p1", "p2", "p3"] as const).flatMap((level) => {
    const count = verdict[level] ?? 0;
    return count > 0 ? [`${level.toUpperCase()} ${count}`] : [];
  });
  const tone =
    (verdict.p0 ?? 0) + (verdict.p1 ?? 0) > 0
      ? "border-red-400/50 text-red-300"
      : (verdict.p2 ?? 0) > 0
        ? "border-amber-400/50 text-amber-300"
        : counts.length > 0
          ? "text-muted"
          : "border-emerald-400/40 text-emerald-300";
  return { text: `${verdict.role} ${counts.length === 0 ? "clean" : counts.join(" ")}`, tone };
}

const prText = (pr: NonNullable<Ticket["pr"]>) => {
  const text = String(pr);
  return /^\d+$/.test(text) ? `#${text}` : (text.split("/").at(-1) ?? text);
};

/** A ticket on its lane: what it is, where its work lives, its reviews, and the agents on it. */
export function TicketFrame({
  view,
  box,
  offset,
  selectedThreadId,
  onDrag,
  onDrop,
  onOpen,
}: {
  view: TicketView;
  box: FrameBox;
  /** How far the frame is dragged from its place, in canvas px. */
  offset: number;
  selectedThreadId: string | null;
  onDrag: (dy: number) => void;
  onDrop: () => void;
  onOpen: (threadId: string | null) => void;
}) {
  const { ticket, agents } = view;
  const scale = useViewScale();
  const press = useRef<{ startY: number; dragging: boolean } | null>(null);
  const seen = new Map<string, number>();
  const verdicts = (ticket.verdicts ?? []).map((verdict) => {
    const chipText = verdictText(verdict);
    const earlier = seen.get(chipText.text) ?? 0;
    seen.set(chipText.text, earlier + 1);
    return { ...chipText, id: `${chipText.text}#${earlier}` };
  });

  return (
    <article
      data-testid="ticket-frame"
      data-ticket={ticket.key}
      aria-label={`${ticket.key} ${ticket.title}`}
      className={`absolute rounded-lg border border-line bg-panel shadow-panel ${offset === 0 ? "" : "z-10 opacity-95"}`}
      style={{
        left: box.x,
        top: box.y,
        width: box.width,
        height: box.height,
        transform: offset === 0 ? undefined : `translateY(${offset}px)`,
      }}
    >
      <header
        data-testid="frame-handle"
        className="cursor-grab touch-none px-2.5 pt-2.5 select-none"
        style={{ height: box.head }}
        // The frame drags on its own, so a press here never pans the canvas.
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.stopPropagation();
          press.current = { startY: event.clientY, dragging: false };
        }}
        onPointerMove={(event) => {
          const active = press.current;
          if (active === null) return;
          const moved = event.clientY - active.startY;
          if (!active.dragging && Math.abs(moved) < DRAG_THRESHOLD_PX) return;
          if (!active.dragging) {
            active.dragging = true;
            event.currentTarget.setPointerCapture(event.pointerId);
          }
          onDrag(moved / scale);
        }}
        onPointerUp={() => {
          if (press.current?.dragging) onDrop();
          press.current = null;
        }}
        onPointerCancel={() => {
          if (press.current?.dragging) onDrop();
          press.current = null;
        }}
      >
        <div className="flex items-center gap-1.5">
          <span className="rounded bg-hover px-1.5 font-mono text-[11px] leading-[18px] font-semibold text-fg">
            {ticket.key}
          </span>
          {ticket.track != null && (
            <span className="min-w-0 truncate text-[11px] text-faint">{ticket.track}</span>
          )}
        </div>
        <button
          type="button"
          onClick={() => onOpen(agents[0]?.threadId ?? null)}
          className="mt-1.5 line-clamp-2 h-[38px] w-full text-left text-[13px] leading-[19px] font-semibold text-fg"
        >
          {ticket.title}
        </button>
        <p className="mt-1 flex min-w-0 items-center gap-1 text-[11px] text-faint">
          <GitBranch className="size-3 shrink-0" aria-hidden />
          <span className="truncate">
            {ticket.branch == null
              ? "No branch yet"
              : ticket.base == null
                ? ticket.branch
                : `${ticket.branch} → ${ticket.base}`}
          </span>
        </p>
        {hasChips(ticket) && (
          <div className="mt-1.5 flex h-[44px] flex-wrap content-start gap-1 overflow-hidden">
            {ticket.pr != null && <span className={chip}>PR {prText(ticket.pr)}</span>}
            {ticket.headSha != null && (
              <span className={`${chip} font-mono`}>{ticket.headSha.slice(0, 7)}</span>
            )}
            {(ticket.fixRounds ?? 0) > 0 && (
              <span className={chip}>
                <RotateCcw className="size-3" aria-hidden />
                Fix round {ticket.fixRounds}
              </span>
            )}
            {(ticket.dependsOn ?? []).length > 0 && (
              <span className={chip}>
                <ArrowRight className="size-3" aria-hidden />
                After {(ticket.dependsOn ?? []).join(", ")}
              </span>
            )}
            {verdicts.map(({ id, text, tone }) => (
              <span key={id} data-testid="verdict-chip" className={`${chip} ${tone}`}>
                <span className="truncate">{text}</span>
              </span>
            ))}
            {(ticket.flags ?? []).map((flag) => (
              <span key={flag} className={`${chip} border-amber-400/50 text-amber-300`}>
                {flag}
              </span>
            ))}
          </div>
        )}
      </header>
      <div className="flex flex-col" style={{ gap: CARD_GAP, padding: FRAME_PAD }}>
        {agents.length === 0 ? (
          <p className="px-1 text-[11px] text-faint">No agents yet</p>
        ) : (
          agents.map((agent) => (
            <AgentCard
              key={agent.threadId}
              agent={agent}
              selected={agent.threadId === selectedThreadId}
              onOpen={() => onOpen(agent.threadId)}
            />
          ))
        )}
      </div>
    </article>
  );
}
