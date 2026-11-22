import { useState, type CSSProperties, type UIEvent } from "react";
import { CHART_SERIES, INSIGHTS, type InsightCard } from "../data/fixtures";
import type { InsightVariant } from "../urlState";
import { Icon } from "./Icon";
import "./InsightStrip.css";
import "./InsightStrip.a.css";
import "./InsightStrip.b.css";
import "./InsightStrip.c.css";

/**
 * Per-variant geometry in CSS px, so sparklines draw at their exact size. `height` is the strip and
 * the chart card alike (opening a chart never moves the list); `gutter` is the room for y labels.
 */
const LAYOUT = {
  a: {
    rows: 2,
    card: 160,
    columns: 3,
    step: 166,
    height: 214,
    chart: { width: 345, height: 142, gutter: 26, ticks: [0, 4, 8, 12], days: [0, 9, 19, 29] },
  },
  b: {
    rows: 2,
    card: 160,
    columns: 3,
    step: 162,
    height: 210,
    // Detail card: 393 screen − 2×12 gutter − 2×1 border − 2×12 padding.
    chart: { width: 343, height: 126, gutter: 26, ticks: [0, 4, 8, 12], days: [0, 9, 19, 29] },
  },
  c: {
    rows: 1,
    card: 337,
    columns: 6,
    step: 345,
    height: 119,
    chart: { width: 219, height: 75, gutter: 0, ticks: [0, 6, 12], days: [0, 29] },
  },
} as const satisfies Record<InsightVariant, unknown>;

/** Production's card face (apps/web TasksInsights.tsx): 24px viewBox Lucide trend icons, 14px, stroke 2. */
function Trend(props: { readonly down?: boolean | undefined }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {props.down ? (
        <path d="M16 17h6v-6m0 6-8.5-8.5-5 5L2 7" />
      ) : (
        <path d="M16 7h6v6m0-6-8.5 8.5-5-5L2 17" />
      )}
    </svg>
  );
}

function Change(props: { readonly card: InsightCard }) {
  const { card } = props;
  if (card.change === null) return null;
  return (
    <span className="m-ins-delta m-tnum" data-tone={card.tone}>
      <Trend down={card.down} />
      {card.change}
    </span>
  );
}

/** A corner that faces another card is half as round as one on the group's edge (production's blockRadius). */
function radiusOf(row: number, rows: number, column: number, columns: number) {
  // Corners that face another card are square; only the grid's outer corners round (12px).
  const radius = (outer: boolean) => `${outer ? 12 : 0}px`;
  const left = column === 0;
  const right = column === columns - 1;
  return `${radius(row === 0 && left)} ${radius(row === 0 && right)} ${radius(row === rows - 1 && right)} ${radius(row === rows - 1 && left)}`;
}

/** A Catmull-Rom curve through the points, so the line flows instead of kinking. */
function smoothPath(points: ReadonlyArray<readonly [number, number]>) {
  const first = points[0]!;
  let path = `M${first[0].toFixed(1)},${first[1].toFixed(1)}`;
  for (let index = 0; index < points.length - 1; index++) {
    const p0 = points[index - 1] ?? points[index]!;
    const p1 = points[index]!;
    const p2 = points[index + 1]!;
    const p3 = points[index + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6] as const;
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6] as const;
    path += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return path;
}

/**
 * Production's Sparkline (InsightCharts.tsx): straight segments in the muted colour, 28px high,
 * x from 1 to width-1, 12% padding on the extent, 1.5px stroke at 70%, a 22% → 0 area, no marker.
 */
function Sparkline(props: {
  readonly id: string;
  readonly points: ReadonlyArray<number>;
  readonly width: number;
}) {
  const { width } = props;
  const height = 28;
  const min = Math.min(...props.points);
  const max = Math.max(...props.points);
  const pad = (max - min) * 0.12 || Math.abs(max) * 0.1 || 1;
  const low = min - pad;
  const high = max + pad;
  const x = (index: number) => 1 + (index / Math.max(1, props.points.length - 1)) * (width - 2);
  const y = (value: number) => height - 3 - ((value - low) / (high - low)) * (height - 6);
  const line = props.points
    .map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`)
    .join(" ");
  const area = `${line} L${x(props.points.length - 1).toFixed(1)},${height} L${x(0).toFixed(1)},${height} Z`;
  return (
    <div className="m-ins-spark" aria-hidden>
      <svg width={width} height={height} className="m-ins-spark-svg">
        <defs>
          <linearGradient id={props.id} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity={0.22} />
            <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${props.id})`} />
        <path
          d={line}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.7}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

function Card(props: {
  readonly card: InsightCard;
  readonly variant: InsightVariant;
  readonly index: number;
  readonly onOpen: () => void;
}) {
  const { card, variant } = props;
  const layout = LAYOUT[variant];
  const perRow = Math.ceil(INSIGHTS.length / layout.rows);
  const row = Math.floor(props.index / perRow);
  const column = props.index % perRow;
  const style: CSSProperties = {
    gridRow: row + 1,
    gridColumn: column + 1,
    borderRadius: radiusOf(row, layout.rows, column, variant === "c" ? 1 : layout.columns),
  };
  return (
    <button
      className="m-ins"
      data-row={row}
      style={style}
      onClick={props.onOpen}
      aria-label={`${card.label}, ${card.value}`}
    >
      <span className="m-ins-label">{card.label}</span>
      <span className="m-ins-row">
        <span className="m-ins-value m-tnum" data-empty={card.value === "–"}>
          {card.value}
        </span>
        <Change card={card} />
      </span>
      <Sparkline
        id={`m-ins-fill-${variant}-${card.id}`}
        points={card.trend ?? []}
        width={layout.card - 26}
      />
    </button>
  );
}

function formatDay(index: number) {
  // CHART_SERIES is the 30 days ending Nov 20.
  const day = new Date(2026, 10, 20 - (CHART_SERIES.length - 1 - index));
  return day.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** The chart card a tap opens in the strip's place: the period's line, a faint grid, a crosshair on touch. */
function Detail(props: {
  readonly card: InsightCard;
  readonly variant: InsightVariant;
  readonly onClose: () => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const { width, height, gutter: left, ticks, days } = LAYOUT[props.variant].chart;
  const axisHeight = 16;
  const max = 12;
  const x = (index: number) => left + (index / (CHART_SERIES.length - 1)) * (width - left);
  const y = (value: number) => 6 + (1 - value / max) * (height - axisHeight - 6);
  const coords = CHART_SERIES.map((value, index) => [x(index), y(value)] as const);
  const line = smoothPath(coords);
  const shown = hover === null ? null : CHART_SERIES[hover]!;
  return (
    <div className="m-ins-detail" data-tone={props.card.tone}>
      <button className="m-ins-close" onClick={props.onClose} aria-label="Close chart">
        <Icon name="close" size={14} />
      </button>
      <div className="m-ins-detail-head">
        <div className="m-ins-label">{props.card.label}</div>
        <div className="m-ins-detail-row">
          <span className="m-ins-value m-tnum">
            {shown === null ? props.card.value : String(shown)}
          </span>
          {hover === null ? <Change card={props.card} /> : null}
          <span className="m-ins-period">{hover === null ? "30 days" : formatDay(hover)}</span>
        </div>
      </div>
      <svg
        className="m-ins-chart"
        width={width}
        height={height}
        onPointerMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const scale = box.width / width;
          const index = Math.round(
            (((event.clientX - box.left) / scale - left) / (width - left)) *
              (CHART_SERIES.length - 1),
          );
          setHover(Math.max(0, Math.min(CHART_SERIES.length - 1, index)));
        }}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient
            className="m-ins-series"
            id="m-ins-chart-fill"
            x1="0"
            y1="0"
            x2="0"
            y2="1"
          >
            <stop offset="0" stopColor="currentColor" stopOpacity="0.2" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              className="m-ins-grid-line"
              x1={left}
              x2={width}
              y1={y(tick)}
              y2={y(tick)}
              strokeDasharray="2 5"
            />
            {left > 0 ? (
              <text className="m-ins-axis" x={0} y={y(tick) + 4}>
                {tick}
              </text>
            ) : null}
          </g>
        ))}
        <g className="m-ins-series">
          <path
            d={`${line} L${x(CHART_SERIES.length - 1)},${y(0)} L${left},${y(0)} Z`}
            fill="url(#m-ins-chart-fill)"
          />
          <path
            d={line}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
        {days.map((index, position) => (
          <text
            key={index}
            className="m-ins-axis"
            x={x(index)}
            y={height - 3}
            textAnchor={position === 0 ? "start" : position === days.length - 1 ? "end" : "middle"}
          >
            {formatDay(index)}
          </text>
        ))}
        {hover !== null ? (
          <g className="m-ins-series">
            <line className="m-ins-crosshair" x1={x(hover)} x2={x(hover)} y1={2} y2={y(0)} />
            <circle
              className="m-ins-dot"
              cx={x(hover)}
              cy={y(CHART_SERIES[hover]!)}
              r="4.5"
              strokeWidth="2.5"
            />
          </g>
        ) : null}
      </svg>
    </div>
  );
}

/** The board's insights, in the variant picked by `&insights=` (a: tiles, b: one panel, c: one-at-a-time carousel). */
export function InsightStrip(props: {
  readonly variant: InsightVariant;
  readonly initiallyOpen?: boolean;
}) {
  const { variant } = props;
  const layout = LAYOUT[variant];
  const [open, setOpen] = useState<InsightCard | null>(props.initiallyOpen ? INSIGHTS[0]! : null);
  const [page, setPage] = useState(0);
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const scroller = event.currentTarget;
    const reach = scroller.scrollWidth - scroller.clientWidth;
    scroller.parentElement?.style.setProperty(
      "--progress",
      String(reach > 0 ? scroller.scrollLeft / reach : 0),
    );
    setPage(Math.min(INSIGHTS.length - 1, Math.round(scroller.scrollLeft / layout.step)));
  };
  return (
    <div className="m-ins-root" data-variant={variant} style={{ height: layout.height }}>
      {open ? (
        <Detail card={open} variant={variant} onClose={() => setOpen(null)} />
      ) : (
        <>
          <div className="m-ins-scroll m-scroll" data-testid="insight-scroll" onScroll={onScroll}>
            <div className="m-ins-grid">
              {INSIGHTS.map((card, index) => (
                <Card
                  key={card.id}
                  card={card}
                  variant={variant}
                  index={index}
                  onOpen={() => setOpen(card)}
                />
              ))}
            </div>
          </div>
          {variant === "b" ? (
            <>
              <div className="m-ins-fade" />
              <div className="m-ins-fade m-ins-fade-start" />
            </>
          ) : null}
          {variant === "c" ? (
            <div className="m-ins-dots" aria-hidden>
              {INSIGHTS.map((card, index) => (
                <span key={card.id} data-active={index === page} />
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
