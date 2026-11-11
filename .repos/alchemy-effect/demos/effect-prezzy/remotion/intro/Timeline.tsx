import { interpolate } from "remotion";
import type { PhaseTimeline } from "../../shared/intro.ts";
import { mono, sans } from "../fonts.ts";
import { brand } from "../theme.ts";
import { TONE } from "./draw.tsx";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

// The drawing sits where the cloud diagram does.
const X = 1090;
const W = 720;
const BAND = 250; // construction band width
const TOP = 320;
const ROW = 130;
const CHIP = { w: 196, h: 64 };

/**
 * A cloud program over time: construction creates every resource once, at deploy;
 * then the runtime runs on every request, using what construction made.
 */
export const TimelineView = ({
  timeline,
  local,
  delay,
}: {
  timeline: PhaseTimeline;
  local: number;
  delay: number;
}) => {
  const rows = timeline.resources;
  const fnRow = rows.length - 1;
  const rowY = (i: number) => TOP + 70 + i * ROW;
  const axisY = rowY(fnRow) + 90;
  const runX = X + BAND + 30;
  const runW = W - BAND - 30;
  const show = (at: number, frames = 5) =>
    interpolate(local, [delay + at, delay + at + frames], [0, 1], clamp);

  const chips = rows.map((r, i) => {
    const p = show(i * 4);
    const y = rowY(i);
    return (
      <g
        key={r.title}
        opacity={p}
        transform={`translate(${X + BAND / 2} ${y}) scale(${0.85 + 0.15 * p})`}
      >
        <rect
          x={-CHIP.w / 2}
          y={-CHIP.h / 2}
          width={CHIP.w}
          height={CHIP.h}
          rx="14"
          fill="#221e18"
          stroke={r.color}
          strokeWidth="3"
        />
        <circle cx={-CHIP.w / 2 + 26} cy="0" r="7" fill={r.color} />
        <text
          x={-CHIP.w / 2 + 44}
          y="9"
          fontFamily={sans}
          fontWeight="700"
          fontSize="26"
          fill={brand.fg}
        >
          {r.title}
        </text>
      </g>
    );
  });

  // Each resource lives on after construction.
  const lifetimes = rows.map((r, i) => {
    const p = show(rows.length * 4 + i * 2, 10);
    const x1 = X + BAND / 2 + CHIP.w / 2;
    return (
      <line
        key={r.title}
        x1={x1}
        y1={rowY(i)}
        x2={x1 + (X + W - x1) * p}
        y2={rowY(i)}
        stroke={r.color}
        strokeWidth="2"
        strokeDasharray="6 8"
        opacity="0.5"
      />
    );
  });

  // Requests: each one runs the function, which reads the bucket and sends to the queue.
  const start = rows.length * 4 + 8;
  const requests = Array.from({ length: timeline.requests }, (_, k) => {
    const x = runX + 40 + (k * (runW - 70)) / Math.max(1, timeline.requests - 1);
    const p = show(start + k * 5, 4);
    return (
      <g key={k} opacity={p}>
        <line
          x1={x}
          y1={axisY}
          x2={x}
          y2={rowY(0)}
          stroke={TONE.runtime}
          strokeWidth="2.5"
          opacity="0.45"
        />
        {rows.map((_, i) => (
          <circle
            key={i}
            cx={x}
            cy={rowY(i)}
            r={i === fnRow ? 11 : 7}
            fill={TONE.runtime}
            opacity={i === fnRow ? 1 : 0.8}
          />
        ))}
        <path
          d={`M ${x - 7} ${axisY + 16} L ${x} ${axisY + 4} L ${x + 7} ${axisY + 16}`}
          fill="none"
          stroke={TONE.runtime}
          strokeWidth="2.5"
        />
      </g>
    );
  });

  const head = (x: number, label: string, sub: string, color: string, at: number) => (
    <g opacity={show(at)}>
      <text x={x} y={TOP - 34} fontFamily={mono} fontWeight="700" fontSize="26" fill={color}>
        {label}
      </text>
      <text x={x} y={TOP - 4} fontFamily={mono} fontSize="20" fill={brand.fgMuted}>
        {sub}
      </text>
    </g>
  );

  return (
    <svg
      width={1920}
      height={1080}
      style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }}
    >
      <text x={X} y={190} fontFamily={mono} fontSize="22" fill={brand.fgMuted}>
        the cloud, over time
      </text>
      <rect
        x={X}
        y={TOP + 10}
        width={BAND}
        height={axisY - TOP - 24}
        rx="16"
        fill={TONE.construct}
        fillOpacity="0.1"
        stroke={TONE.construct}
        strokeWidth="2"
        strokeDasharray="8 7"
        opacity={show(0)}
      />
      {head(X + 14, "construction", "once, at deploy", TONE.construct, 0)}
      {head(runX, "runtime", "on every request", TONE.runtime, start)}
      {lifetimes}
      {chips}
      {requests}
      <g opacity={show(0)}>
        <line x1={X} y1={axisY} x2={X + W} y2={axisY} stroke={brand.fgMuted} strokeWidth="2" />
        <path
          d={`M ${X + W - 12} ${axisY - 8} L ${X + W} ${axisY} L ${X + W - 12} ${axisY + 8}`}
          fill="none"
          stroke={brand.fgMuted}
          strokeWidth="2"
        />
        <text
          x={X + W}
          y={axisY + 40}
          textAnchor="end"
          fontFamily={mono}
          fontSize="20"
          fill={brand.fgMuted}
        >
          time →
        </text>
        <text x={runX} y={axisY + 40} fontFamily={mono} fontSize="20" fill={brand.fgMuted}>
          requests
        </text>
      </g>
    </svg>
  );
};
