import { interpolate } from "remotion";
import type { Tone } from "../../shared/intro.ts";
import { brand } from "../theme.ts";

/** Colours for phases and verdicts, shared by code tints, marks and boards. */
export const TONE: Record<Tone, string> = {
  construct: brand.moss,
  runtime: "#e0a86b",
  good: "#7ee787",
  bad: "#ff7b72",
  neutral: "#c9c1ae",
};

/** Deterministic wobble, so a mark looks hand-drawn but renders the same every frame. */
const wobble = (seed: number) => {
  const x = Math.sin(seed * 91.17) * 43758.5453;
  return x - Math.floor(x) - 0.5;
};

/** Reveal a stroke from 0 to 1 over `frames`, starting at `delay`. */
export const drawProgress = (frame: number, delay: number, frames = 16) =>
  interpolate(frame, [delay, delay + frames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: (t) => 1 - (1 - t) ** 2,
  });

const stroke = (d: string, color: string, progress: number, width = 4) => {
  const length = 4000;
  return (
    <path
      d={d}
      fill="none"
      stroke={color}
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeDasharray={length}
      strokeDashoffset={length * (1 - progress)}
    />
  );
};

/** A loose ellipse around a box, a little over one full turn like a pen stroke. */
export const circlePath = (x: number, y: number, w: number, h: number, seed = 1) => {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rx = w / 2 + 18;
  const ry = h / 2 + 12;
  const points: string[] = [];
  const turns = 1.12;
  const steps = 48;
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * turns * Math.PI * 2 - Math.PI * 0.6;
    const jitter = 1 + wobble(seed + i) * 0.05;
    points.push(`${cx + Math.cos(t) * rx * jitter},${cy + Math.sin(t) * ry * jitter}`);
  }
  return `M ${points.join(" L ")}`;
};

export const underlinePath = (x: number, y: number, w: number, seed = 1) => {
  const mid = x + w / 2 + wobble(seed) * 10;
  return `M ${x - 4} ${y} Q ${mid} ${y + 6 + wobble(seed + 1) * 4} ${x + w + 4} ${y - 2}`;
};

export const strikePath = (x: number, y: number, w: number, seed = 1) =>
  `M ${x - 6} ${y + wobble(seed) * 3} L ${x + w + 6} ${y + wobble(seed + 2) * 3}`;

export const boxPath = (x: number, y: number, w: number, h: number, seed = 1) => {
  const p = (px: number, py: number, s: number) =>
    `${px + wobble(seed + s) * 5},${py + wobble(seed + s + 7) * 5}`;
  const l = x - 12;
  const r = x + w + 12;
  const t = y - 8;
  const b = y + h + 8;
  return `M ${p(l, t, 1)} L ${p(r, t, 2)} L ${p(r, b, 3)} L ${p(l, b, 4)} Z`;
};

/** A curved arrow from (x1,y1) to (x2,y2), with its head. */
export const Arrow = ({
  x1,
  y1,
  x2,
  y2,
  color,
  progress,
  bend = 0.25,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  progress: number;
  bend?: number;
}) => {
  const mx = (x1 + x2) / 2 - (y2 - y1) * bend;
  const my = (y1 + y2) / 2 + (x2 - x1) * bend;
  const angle = Math.atan2(y2 - my, x2 - mx);
  const head = 16;
  const a1 = angle + Math.PI * 0.82;
  const a2 = angle - Math.PI * 0.82;
  return (
    <g>
      {stroke(`M ${x1} ${y1} Q ${mx} ${my} ${x2} ${y2}`, color, progress, 3.5)}
      {progress > 0.92
        ? stroke(
            `M ${x2 + Math.cos(a1) * head} ${y2 + Math.sin(a1) * head} L ${x2} ${y2} L ${x2 + Math.cos(a2) * head} ${y2 + Math.sin(a2) * head}`,
            color,
            1,
            3.5,
          )
        : null}
    </g>
  );
};

export { stroke };
