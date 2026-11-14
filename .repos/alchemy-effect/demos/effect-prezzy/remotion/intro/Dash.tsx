import { interpolate } from "remotion";
import type { DashStep } from "../../shared/intro.ts";
import { mono, sans } from "../fonts.ts";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** A generic observability product's dark theme (hypothetical UI). */
const UI = {
  bg: "#0f1115",
  panel: "#171a21",
  border: "#2a2f3a",
  fg: "#e8eaf0",
  muted: "#8a93a6",
  line: "#56b6c2",
  error: "#f47067",
  ok: "#57ab5a",
  warn: "#e0a86b",
};

const BOX = { x: 110, y: 170, w: 1700, h: 860 };
const POINTS = 48;

/** Deterministic noise so every render draws the same chart. */
const noise = (i: number, seed: number) => {
  const x = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
  return x - Math.floor(x);
};
const requests = Array.from(
  { length: POINTS },
  (_, i) => 60 + 25 * Math.sin(i / 6) + 18 * noise(i, 1),
);
/** Errors stay low, then spike near the end (the incident the monitor catches). */
const errors = (spike: boolean) =>
  Array.from({ length: POINTS }, (_, i) =>
    spike && i >= 40 ? 14 + 10 * noise(i, 3) + (i - 40) * 2 : 1.5 * noise(i, 2),
  );

const Chart = ({
  x,
  y,
  w,
  h,
  title,
  values,
  color,
  max,
  threshold,
  reveal,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  values: number[];
  color: string;
  max: number;
  threshold?: number;
  reveal: number;
}) => {
  const px = (i: number) => x + 24 + (i / (values.length - 1)) * (w - 48);
  const py = (v: number) => y + h - 28 - (v / max) * (h - 90);
  const shown = Math.max(2, Math.round(values.length * reveal));
  const d = values
    .slice(0, shown)
    .map((v, i) => `${i === 0 ? "M" : "L"} ${px(i)} ${py(v)}`)
    .join(" ");
  const area = `${d} L ${px(shown - 1)} ${y + h - 28} L ${px(0)} ${y + h - 28} Z`;
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={12}
        fill={UI.panel}
        stroke={UI.border}
        strokeWidth={2}
      />
      <text x={x + 24} y={y + 40} fontFamily={sans} fontWeight={600} fontSize={24} fill={UI.fg}>
        {title}
      </text>
      {[0.25, 0.5, 0.75].map((f) => (
        <line
          key={f}
          x1={x + 24}
          x2={x + w - 24}
          y1={py(max * f)}
          y2={py(max * f)}
          stroke={UI.border}
          strokeWidth={1}
        />
      ))}
      {threshold !== undefined ? (
        <g>
          <line
            x1={x + 24}
            x2={x + w - 24}
            y1={py(threshold)}
            y2={py(threshold)}
            stroke={UI.warn}
            strokeWidth={2}
            strokeDasharray="8 6"
          />
          <text
            x={x + w - 28}
            y={py(threshold) - 8}
            textAnchor="end"
            fontFamily={mono}
            fontSize={18}
            fill={UI.warn}
          >
            threshold 10
          </text>
        </g>
      ) : null}
      <path d={area} fill={color} opacity={0.12} />
      <path d={d} fill="none" stroke={color} strokeWidth={3} strokeLinejoin="round" />
    </g>
  );
};

const SPANS: [string, number, boolean][] = [
  ["Chat fetch /join/lobby", 42, false],
  ["  Rooms.join", 38, false],
  ["    Room webSocketMessage", 12, false],
  ["      History.append", 6, false],
  ["Chat fetch /attach/lobby", 180, true],
  ["  Files.upload", 171, true],
];

/**
 * A mocked dashboard for the chat app: request and error charts, recent
 * traces, and the monitor. With `alert`, errors spike past the threshold,
 * the monitor turns red, and a notification slides in.
 */
export const DashView = ({
  step,
  prev,
  local,
}: {
  step: DashStep;
  prev?: DashStep;
  local: number;
}) => {
  const fresh = !prev;
  const enter = fresh ? interpolate(local, [0, 8], [0, 1], clamp) : 1;
  const reveal = fresh ? interpolate(local, [4, 24], [0.05, 1], clamp) : 1;
  const spike = !!step.alert;
  const alertIn =
    spike && !prev?.alert ? interpolate(local, [6, 16], [0, 1], clamp) : spike ? 1 : 0;
  const errs = errors(spike);
  const errorReveal =
    spike && !prev?.alert ? interpolate(local, [0, 10], [40 / POINTS, 1], clamp) : reveal;

  const left = BOX.x + 28;
  const chartW = (BOX.w - 28 * 3) / 2;
  return (
    <svg
      width={1920}
      height={1080}
      style={{ position: "absolute", left: 0, top: 0, opacity: enter }}
    >
      <rect
        x={BOX.x}
        y={BOX.y}
        width={BOX.w}
        height={BOX.h}
        rx={18}
        fill={UI.bg}
        stroke={UI.border}
        strokeWidth={2}
      />
      <text x={left} y={BOX.y + 56} fontFamily={sans} fontWeight={700} fontSize={32} fill={UI.fg}>
        Chat
      </text>
      <text x={left + 90} y={BOX.y + 56} fontFamily={mono} fontSize={20} fill={UI.muted}>
        dashboard · last 1h · chat-traces
      </text>
      <text
        x={BOX.x + BOX.w - 28}
        y={BOX.y + 56}
        textAnchor="end"
        fontFamily={mono}
        fontSize={18}
        fill={UI.muted}
      >
        hypothetical UI
      </text>

      <Chart
        x={left}
        y={BOX.y + 90}
        w={chartW}
        h={330}
        title="Requests / min"
        values={requests}
        color={UI.line}
        max={110}
        reveal={reveal}
      />
      <Chart
        x={left + chartW + 28}
        y={BOX.y + 90}
        w={chartW}
        h={330}
        title="Errors / min"
        values={errs}
        color={UI.error}
        max={34}
        threshold={10}
        reveal={errorReveal}
      />

      {/* Recent traces */}
      <rect
        x={left}
        y={BOX.y + 450}
        width={chartW}
        height={380}
        rx={12}
        fill={UI.panel}
        stroke={UI.border}
        strokeWidth={2}
      />
      <text
        x={left + 24}
        y={BOX.y + 490}
        fontFamily={sans}
        fontWeight={600}
        fontSize={24}
        fill={UI.fg}
      >
        Recent traces
      </text>
      {SPANS.map(([name, ms, bad], i) => {
        const y = BOX.y + 540 + i * 46;
        const isBad = bad && spike;
        return (
          <g
            key={name}
            opacity={interpolate(
              local,
              [8 + i * 2, 14 + i * 2],
              [0, 1],
              fresh
                ? clamp
                : { extrapolateLeft: "extend" as const, extrapolateRight: "clamp" as const },
            )}
          >
            <text
              x={left + 24}
              y={y}
              fontFamily={mono}
              fontSize={20}
              fill={isBad ? UI.error : UI.fg}
              style={{ whiteSpace: "pre" }}
            >
              {name}
            </text>
            <rect
              x={left + 430}
              y={y - 16}
              width={Math.max(8, ms * 1.4)}
              height={18}
              rx={4}
              fill={isBad ? UI.error : UI.line}
              opacity={0.75}
            />
            <text
              x={left + chartW - 24}
              y={y}
              textAnchor="end"
              fontFamily={mono}
              fontSize={18}
              fill={UI.muted}
            >
              {isBad ? "error" : `${ms} ms`}
            </text>
          </g>
        );
      })}

      {/* Monitor */}
      {(() => {
        const x = left + chartW + 28;
        const y = BOX.y + 450;
        const color = spike ? UI.error : UI.ok;
        return (
          <g>
            <rect
              x={x}
              y={y}
              width={chartW}
              height={380}
              rx={12}
              fill={UI.panel}
              stroke={spike ? UI.error : UI.border}
              strokeWidth={spike ? 3 : 2}
            />
            <text
              x={x + 24}
              y={y + 40}
              fontFamily={sans}
              fontWeight={600}
              fontSize={24}
              fill={UI.fg}
            >
              Monitors
            </text>
            <circle cx={x + 40} cy={y + 96} r={11} fill={color} />
            <text
              x={x + 64}
              y={y + 104}
              fontFamily={sans}
              fontWeight={600}
              fontSize={26}
              fill={UI.fg}
            >
              Chat errors
            </text>
            <text
              x={x + chartW - 24}
              y={y + 104}
              textAnchor="end"
              fontFamily={mono}
              fontSize={22}
              fill={color}
            >
              {spike ? "ALERTING" : "OK"}
            </text>
            <text x={x + 64} y={y + 144} fontFamily={mono} fontSize={19} fill={UI.muted}>
              count(error) above 10 · every 5 min
            </text>
            {spike ? (
              <g opacity={alertIn}>
                <text x={x + 64} y={y + 200} fontFamily={mono} fontSize={20} fill={UI.error}>
                  27 errors in the last 5 min
                </text>
                <text x={x + 64} y={y + 236} fontFamily={mono} fontSize={20} fill={UI.muted}>
                  top span: Files.upload · R2 timeout
                </text>
              </g>
            ) : (
              <text x={x + 64} y={y + 200} fontFamily={mono} fontSize={20} fill={UI.muted}>
                last fired: never
              </text>
            )}
          </g>
        );
      })()}

      {/* Notification, when the monitor fires */}
      {spike ? (
        <g opacity={alertIn} transform={`translate(${(1 - alertIn) * 40} 0)`}>
          <rect
            x={1180}
            y={880}
            width={590}
            height={118}
            rx={14}
            fill="#241516"
            stroke={UI.error}
            strokeWidth={3}
          />
          <text x={1206} y={924} fontFamily={sans} fontWeight={700} fontSize={26} fill={UI.error}>
            ● Monitor fired: Chat errors
          </text>
          <text x={1206} y={966} fontFamily={mono} fontSize={19} fill={UI.fg}>
            → sent to the agent: Files.upload failing
          </text>
        </g>
      ) : null}
    </svg>
  );
};
