import type { PoolProjection } from "@t3tools/shared/usagePoolProjection";
import { useId, useLayoutEffect, useRef, useState } from "react";

import { observeResize } from "../../lib/observeResize";

const HEIGHT = 190;
const PAD = { left: 44, right: 8, top: 22, bottom: 22 };
const DAY = 86_400_000;
const HOUR = 3_600_000;

type Point = { readonly at: number; readonly remaining: number };

function percent(value: number) {
  return `${Math.round(value)}%`;
}

function timeTicks(from: number, to: number): ReadonlyArray<{ at: number; label: string }> {
  const span = to - from;
  if (span > 2 * DAY) {
    const every = Math.max(1, Math.ceil(span / DAY / 10));
    const start = new Date(from);
    start.setHours(24, 0, 0, 0);
    const ticks = [];
    for (let at = start.getTime(); at < to; at += every * DAY) {
      ticks.push({
        at: at + DAY / 2,
        label: new Date(at).toLocaleDateString([], { weekday: "short", day: "numeric" }),
      });
    }
    return ticks;
  }
  const start = new Date(from);
  start.setMinutes(60, 0, 0);
  while (start.getHours() % 3 !== 0) start.setHours(start.getHours() + 1);
  const ticks = [];
  for (let at = start.getTime(); at < to; at += 3 * HOUR) {
    ticks.push({
      at,
      label: new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    });
  }
  return ticks;
}

/** Drops a label that would overlap the one before it. */
function spacedLabels<T extends { readonly x: number }>(labels: readonly T[]): T[] {
  const shown: T[] = [];
  for (const label of labels) {
    if (label.x - (shown.at(-1)?.x ?? -Infinity) >= 34) shown.push(label);
  }
  return shown;
}

/** Pooled remaining quota: readings so far as a solid line, the projection dashed. */
export function UsagePoolChart({
  color,
  label,
  recorded,
  projection,
  from,
  to,
  now,
  formatTime,
}: {
  readonly color: string;
  readonly label: string;
  readonly recorded: readonly Point[];
  readonly projection: PoolProjection;
  readonly from: number;
  readonly to: number;
  readonly now: number;
  readonly formatTime: (at: number) => string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<Point | null>(null);
  const gradient = useId();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the container DOM width before paint and remeasures through a ResizeObserver
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => setWidth(element.getBoundingClientRect().width);
    measure();
    return observeResize(element, measure);
  }, []);

  const cap = Math.max(100, projection.capacity);
  const x = (at: number) =>
    PAD.left + ((at - from) / (to - from)) * Math.max(0, width - PAD.left - PAD.right);
  const y = (value: number) => PAD.top + (HEIGHT - PAD.top - PAD.bottom) * (1 - value / cap);
  const line = (points: readonly Point[]) =>
    points
      .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.at).toFixed(1)},${y(p.remaining).toFixed(1)}`)
      .join("");
  const all = [...recorded, ...projection.points];
  const first = all[0];
  const last = all.at(-1);
  const area = first && last ? `${line(all)}L${x(last.at)},${y(0)}L${x(first.at)},${y(0)}Z` : "";
  const start = projection.points[0];

  const refillLabels = spacedLabels(
    projection.refills.map((refill) => ({ ...refill, x: x(refill.at) })),
  );

  const pick = (clientX: number) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || all.length === 0) return;
    const at =
      from + ((clientX - rect.left - PAD.left) / (width - PAD.left - PAD.right)) * (to - from);
    setHover(
      all.reduce((best, p) => (Math.abs(p.at - at) < Math.abs(best.at - at) ? p : best), all[0]!),
    );
  };

  return (
    <div ref={box} className="relative w-full" style={{ height: HEIGHT }}>
      {width > 0 ? (
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={`${label}: pooled quota left, recorded and projected`}
          className="block overflow-visible text-2xs"
          onPointerMove={(event) => pick(event.clientX)}
          onPointerLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={color} stopOpacity={0.28} />
              <stop offset="1" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          {[0, cap / 2, cap].map((value) => (
            <g key={value}>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={y(value)}
                y2={y(value)}
                className="stroke-border"
              />
              <text
                x={PAD.left - 6}
                y={y(value) + 3.5}
                textAnchor="end"
                className="fill-muted-foreground tabular-nums"
              >
                {percent(value)}
              </text>
            </g>
          ))}
          {timeTicks(from, to).map((tick) => (
            <text
              key={tick.at}
              x={x(tick.at)}
              y={HEIGHT - 6}
              textAnchor="middle"
              className="fill-muted-foreground"
            >
              {tick.label}
            </text>
          ))}
          <path d={area} fill={`url(#${gradient})`} />
          {recorded.length > 0 && start ? (
            <path
              d={line([...recorded, start])}
              fill="none"
              stroke={color}
              strokeWidth={2}
              strokeLinejoin="round"
            />
          ) : null}
          <path
            d={line(projection.points)}
            fill="none"
            stroke={color}
            strokeWidth={1.75}
            strokeDasharray="5 4"
            strokeLinejoin="round"
          />
          {refillLabels.map((refill) => (
            <text
              key={`${refill.accountKey}:${refill.at}`}
              x={refill.x}
              y={Math.max(PAD.top - 6, y(refill.remainingAfter) - 7)}
              textAnchor="middle"
              className="fill-foreground/70 tabular-nums"
            >
              +{percent(refill.restores)}
            </text>
          ))}
          <line
            x1={x(now)}
            x2={x(now)}
            y1={PAD.top - 8}
            y2={HEIGHT - PAD.bottom}
            className="stroke-muted-foreground/60"
          />
          <text x={x(now)} y={PAD.top - 12} textAnchor="middle" className="fill-muted-foreground">
            Now
          </text>
          {start ? (
            <circle
              cx={x(now)}
              cy={y(start.remaining)}
              r={4}
              fill={color}
              className="stroke-background"
              strokeWidth={2}
            />
          ) : null}
          {projection.poolEmpty !== null && projection.poolEmpty > now ? (
            <g>
              <circle
                cx={x(projection.poolEmpty)}
                cy={y(0)}
                r={5}
                className="fill-background stroke-destructive"
                strokeWidth={2}
              />
              <text
                x={Math.min(x(projection.poolEmpty), width - PAD.right - 56)}
                y={y(0) - 10}
                textAnchor="middle"
                className="fill-foreground/80"
              >
                Empty {formatTime(projection.poolEmpty)}
              </text>
            </g>
          ) : null}
          {hover ? <circle cx={x(hover.at)} cy={y(hover.remaining)} r={4} fill={color} /> : null}
        </svg>
      ) : null}
      {hover ? (
        <div
          className="pointer-events-none absolute top-0 rounded-md border bg-popover px-2 py-1 text-xs shadow-md"
          style={{ left: Math.min(x(hover.at) + 12, Math.max(0, width - 150)) }}
        >
          <div className="text-muted-foreground">
            {formatTime(hover.at)}
            {hover.at > now ? " · projected" : ""}
          </div>
          <div className="font-semibold text-foreground tabular-nums">
            {percent(hover.remaining)} of {percent(projection.capacity)}
          </div>
        </div>
      ) : null}
    </div>
  );
}
