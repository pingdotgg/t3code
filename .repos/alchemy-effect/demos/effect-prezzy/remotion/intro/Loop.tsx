import { interpolate } from "remotion";
import type { LoopPart, LoopStep } from "../../shared/intro.ts";
import { hand, mono, sans } from "../fonts.ts";
import { brand } from "../theme.ts";
import { Arrow, drawProgress, TONE } from "./draw.tsx";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

const NODE = { w: 262, h: 104 };
const COLS = [560, 890, 1220, 1550];
const ROWS = [360, 620, 880];

type Node = { id: LoopPart; title: string; sub: string; row: number; col: number };

/** The path from an edit to production: three lanes, left to right. */
const NODES: Node[] = [
  { id: "edit", title: "edit", sub: "the agent", row: 0, col: 0 },
  { id: "types", title: "type-check", sub: "milliseconds", row: 0, col: 1 },
  { id: "local", title: "test, emulated", sub: "seconds, locally", row: 0, col: 2 },
  { id: "live", title: "test, live", sub: "stage test_sam", row: 0, col: 3 },
  { id: "push", title: "open a PR", sub: "git push", row: 1, col: 0 },
  { id: "pr", title: "deploy pr-42", sub: "branches staging", row: 1, col: 1 },
  { id: "prTest", title: "test", sub: "in CI", row: 1, col: 2 },
  { id: "comment", title: "comment", sub: "preview link", row: 1, col: 3 },
  { id: "merge", title: "merge", sub: "to main", row: 2, col: 0 },
  { id: "staging", title: "deploy staging", sub: "shared by PRs", row: 2, col: 1 },
  { id: "stagingTest", title: "test", sub: "the same tests", row: 2, col: 2 },
  { id: "prod", title: "deploy prod", sub: "when green", row: 2, col: 3 },
];
const LANES = [
  { label: "your machine", color: TONE.construct },
  { label: "pull request", color: TONE.runtime },
  { label: "main", color: "#8b9cf6" },
];

const byId = new Map(NODES.map((n) => [n.id, n]));
const pos = (id: LoopPart) => {
  const n = byId.get(id)!;
  return { x: COLS[n.col]!, y: ROWS[n.row]! };
};

/** Arrows within a lane, and the elbows that carry a lane's result down into the next one. */
const LINKS: [LoopPart, LoopPart][] = [
  ["edit", "types"],
  ["types", "local"],
  ["local", "live"],
  ["push", "pr"],
  ["pr", "prTest"],
  ["prTest", "comment"],
  ["merge", "staging"],
  ["staging", "stagingTest"],
  ["stagingTest", "prod"],
];
const ELBOWS: { from: LoopPart; to: LoopPart; label: string }[] = [
  { from: "live", to: "push", label: "green" },
  { from: "comment", to: "merge", label: "approved" },
];

const DIM = 0.26;
const isShown = (step: LoopStep | undefined, id: LoopPart) =>
  !!step && (!step.show || step.show.includes(id));
const isLit = (step: LoopStep | undefined, id: LoopPart) =>
  !step || !step.lit || step.lit.includes(id);
const glows = (step: LoopStep | undefined, id: LoopPart) => !!step?.focus?.includes(id);
/** The feedback arc runs from the last check drawn on your machine back to the edit. */
const arcFrom = (step: LoopStep | undefined): LoopPart | undefined =>
  (["live", "local", "types"] as const).find((id) => isShown(step, id));

/**
 * The whole loop, full screen. Parts appear as they're introduced (`show`),
 * drawing themselves in order; after that, only what's lit and what glows
 * changes between steps.
 */
export const LoopView = ({
  step,
  prev,
  local,
}: {
  step: LoopStep;
  prev?: LoopStep;
  local: number;
}) => {
  const t = interpolate(local, [0, 10], [0, 1], clamp);
  const level = (id: LoopPart) => {
    const now = isLit(step, id) ? 1 : DIM;
    const then = !isShown(prev, id) ? now : isLit(prev, id) ? 1 : DIM;
    return then + (now - then) * t;
  };
  const glow = (id: LoopPart) => {
    const now = glows(step, id) ? 1 : 0;
    const then = glows(prev, id) ? 1 : 0;
    return then + (now - then) * interpolate(local, [4, 14], [0, 1], clamp);
  };
  // New parts appear one after another, in reading order.
  const fresh = NODES.filter((n) => isShown(step, n.id) && !isShown(prev, n.id)).map((n) => n.id);
  const order = (id: LoopPart) => fresh.indexOf(id);
  const appear = (id: LoopPart) => {
    if (!isShown(step, id)) return 0;
    const k = order(id);
    return k < 0 ? 1 : interpolate(local, [k * 2, k * 2 + 6], [0, 1], clamp);
  };
  const draw = (id: LoopPart) => {
    const k = order(id);
    return k < 0 ? 1 : drawProgress(local, k * 2 + 4, 8);
  };
  const linkShown = (a: LoopPart, b: LoopPart) => isShown(step, a) && isShown(step, b);

  const from = arcFrom(step);
  const feedbackOn = !!from && isShown(step, "feedback") && isShown(step, "edit");
  const feedbackNew = feedbackOn && (!isShown(prev, "feedback") || arcFrom(prev) !== from);
  const feedbackLevel = level("feedback");
  const feedbackGlow = glow("feedback");
  const a = from ? pos(from) : pos("live");
  const b = pos("edit");
  const arcTop = ROWS[0]! - NODE.h / 2 - 110;
  const feedbackColor = feedbackGlow > 0 ? "#7ee787" : TONE.bad;

  return (
    <svg width={1920} height={1080} style={{ position: "absolute", left: 0, top: 0 }}>
      {LANES.map((lane, i) => {
        const inLane = NODES.filter((n) => n.row === i);
        if (!inLane.some((n) => isShown(step, n.id))) return null;
        const isNew = !inLane.some((n) => isShown(prev, n.id));
        return (
          <g key={lane.label} opacity={isNew ? interpolate(local, [0, 6], [0, 1], clamp) : 1}>
            <text
              x={120}
              y={ROWS[i]! + 14}
              fontFamily={hand}
              fontWeight={700}
              fontSize={46}
              fill={lane.color}
            >
              {lane.label}
            </text>
          </g>
        );
      })}

      {/* The feedback arc: every failure goes back to the agent. */}
      {feedbackOn ? (
        <g
          opacity={
            (feedbackNew ? drawProgress(local, fresh.length * 2 + 4, 10) : 1) * feedbackLevel
          }
        >
          <path
            d={`M ${a.x} ${a.y - NODE.h / 2 - 10} C ${a.x} ${arcTop}, ${b.x} ${arcTop}, ${b.x} ${b.y - NODE.h / 2 - 12}`}
            fill="none"
            stroke={feedbackColor}
            strokeWidth={3.5}
            strokeDasharray="12 10"
          />
          <path
            d={`M ${b.x - 11} ${b.y - NODE.h / 2 - 28} L ${b.x} ${b.y - NODE.h / 2 - 10} L ${b.x + 11} ${b.y - NODE.h / 2 - 28}`}
            fill="none"
            stroke={feedbackColor}
            strokeWidth={3.5}
            strokeLinecap="round"
          />
          <text
            x={(a.x + b.x) / 2}
            y={arcTop + 18}
            textAnchor="middle"
            fontFamily={hand}
            fontWeight={700}
            fontSize={40}
            fill={feedbackColor}
          >
            every failure goes back to the agent
          </text>
        </g>
      ) : null}

      {LINKS.filter(([from, to]) => linkShown(from, to)).map(([from, to]) => {
        const p = pos(from);
        const q = pos(to);
        const on = Math.min(level(from), level(to));
        return (
          <g key={`${from}-${to}`} opacity={on}>
            <Arrow
              x1={p.x + NODE.w / 2 + 8}
              y1={p.y}
              x2={q.x - NODE.w / 2 - 8}
              y2={q.y}
              color={brand.fgMuted}
              progress={draw(to)}
              bend={0}
            />
          </g>
        );
      })}

      {ELBOWS.filter((e) => linkShown(e.from, e.to)).map((elbow) => {
        const p = pos(elbow.from);
        const q = pos(elbow.to);
        const midY = (p.y + NODE.h / 2 + q.y - NODE.h / 2) / 2;
        const d = `M ${p.x} ${p.y + NODE.h / 2 + 8} L ${p.x} ${midY} L ${q.x} ${midY} L ${q.x} ${q.y - NODE.h / 2 - 10}`;
        const on = Math.min(level(elbow.from), level(elbow.to));
        const progress = draw(elbow.to);
        return (
          <g key={elbow.label} opacity={on}>
            <path
              d={d}
              fill="none"
              stroke={brand.fgMuted}
              strokeWidth={3}
              strokeDasharray={3000}
              strokeDashoffset={3000 * (1 - progress)}
              strokeLinejoin="round"
            />
            <path
              d={`M ${q.x - 10} ${q.y - NODE.h / 2 - 26} L ${q.x} ${q.y - NODE.h / 2 - 10} L ${q.x + 10} ${q.y - NODE.h / 2 - 26}`}
              fill="none"
              stroke={brand.fgMuted}
              strokeWidth={3}
              opacity={progress >= 1 ? 1 : 0}
            />
            <rect x={p.x - 70} y={midY - 20} width={140} height={40} rx={20} fill={brand.bg} />
            <text
              x={p.x}
              y={midY + 8}
              textAnchor="middle"
              fontFamily={mono}
              fontSize={22}
              fill={TONE.good}
              opacity={progress}
            >
              {elbow.label}
            </text>
          </g>
        );
      })}

      {NODES.filter((n) => isShown(step, n.id)).map((n) => {
        const { x, y } = pos(n.id);
        const q = appear(n.id);
        const g = glow(n.id);
        const color = LANES[n.row]!.color;
        return (
          <g
            key={n.id}
            opacity={q * level(n.id)}
            transform={`translate(${x} ${y}) scale(${0.9 + 0.1 * q})`}
          >
            {g > 0 ? (
              <rect
                x={-NODE.w / 2 - 8}
                y={-NODE.h / 2 - 8}
                width={NODE.w + 16}
                height={NODE.h + 16}
                rx={24}
                fill="none"
                stroke="#7ee787"
                strokeWidth={5}
                opacity={0.55 * g}
              />
            ) : null}
            <rect
              x={-NODE.w / 2}
              y={-NODE.h / 2}
              width={NODE.w}
              height={NODE.h}
              rx={18}
              fill={brand.bgElevated}
              stroke={g > 0.5 ? "#7ee787" : color}
              strokeWidth={3}
            />
            <text
              x={0}
              y={-4}
              textAnchor="middle"
              fontFamily={sans}
              fontWeight={700}
              fontSize={31}
              fill={brand.fg}
            >
              {n.title}
            </text>
            <text
              x={0}
              y={32}
              textAnchor="middle"
              fontFamily={mono}
              fontSize={20}
              fill={brand.fgMuted}
            >
              {n.sub}
            </text>
          </g>
        );
      })}
    </svg>
  );
};
