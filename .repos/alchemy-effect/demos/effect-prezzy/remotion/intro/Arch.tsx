import { interpolate } from "remotion";
import type { ArchStep } from "../../shared/intro.ts";
import { hand, mono, sans } from "../fonts.ts";
import { brand } from "../theme.ts";
import { Arrow, drawProgress } from "./draw.tsx";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const W = 270;
const H = 124;

/**
 * An architecture drawing: boxes appear one after another in the order
 * given, and each arrow draws itself once both of its ends are on screen.
 */
export const ArchView = ({ step, local }: { step: ArchStep; local: number }) => {
  const byId = new Map(step.nodes.map((n) => [n.id, n]));
  const order = (id: string) => step.nodes.findIndex((n) => n.id === id);
  const appear = (id: string) =>
    interpolate(local, [order(id) * 5, order(id) * 5 + 8], [0, 1], clamp);
  const width = (id: string) => byId.get(id)?.w ?? W;
  const height = (id: string) => byId.get(id)?.h ?? H;

  /** Where a line from `a` towards `b` leaves `a`'s box. A tall box is entered level with the other end. */
  const port = (a: string, b: string) => {
    const p = byId.get(a)!;
    const q = byId.get(b)!;
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const h = height(a);
    if (Math.abs(dx) * h > Math.abs(dy) * width(a) || h > H) {
      const y = h > H ? Math.min(p.y + h / 2 - 24, Math.max(p.y - h / 2 + 24, q.y)) : p.y;
      return { x: p.x + Math.sign(dx) * (width(a) / 2 + 10), y };
    }
    return { x: p.x, y: p.y + Math.sign(dy) * (h / 2 + 10) };
  };

  return (
    <svg width={1920} height={1080} style={{ position: "absolute", left: 0, top: 0 }}>
      {(step.lanes ?? []).map((lane, i) => (
        <g key={lane.label} opacity={interpolate(local, [i * 4, i * 4 + 8], [0, 1], clamp)}>
          <text
            x={110}
            y={lane.y + 14}
            fontFamily={hand}
            fontWeight={700}
            fontSize={42}
            fill={lane.color}
          >
            {lane.label}
          </text>
        </g>
      ))}
      {step.edges.map((edge) => {
        const start = Math.max(order(edge.from), order(edge.to)) * 5 + 6;
        const a = port(edge.from, edge.to);
        const b = port(edge.to, edge.from);
        const color = edge.dashed ? "#56b6c2" : brand.fgMuted;
        const p = drawProgress(local, start, 10);
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        if (edge.elbow) {
          const p0 = byId.get(edge.from)!;
          const q0 = byId.get(edge.to)!;
          const sx = p0.x + Math.sign(q0.x - p0.x) * (width(edge.from) / 2 + 10);
          const ty = q0.y + Math.sign(p0.y - q0.y) * (height(edge.to) / 2 + 10);
          const d = `M ${sx} ${p0.y} L ${q0.x} ${p0.y} L ${q0.x} ${ty}`;
          const dir = Math.sign(ty - p0.y);
          return (
            <g key={`${edge.from}-${edge.to}`}>
              <path
                d={d}
                fill="none"
                stroke={color}
                strokeWidth={3}
                strokeDasharray={3000}
                strokeDashoffset={3000 * (1 - p)}
                strokeLinejoin="round"
              />
              <path
                d={`M ${q0.x - 11} ${ty - dir * 16} L ${q0.x} ${ty} L ${q0.x + 11} ${ty - dir * 16}`}
                fill="none"
                stroke={color}
                strokeWidth={3}
                opacity={p >= 1 ? 1 : 0}
              />
              {edge.label ? (
                <text
                  x={q0.x - 18}
                  y={(p0.y + ty) / 2 + 8}
                  textAnchor="end"
                  fontFamily={mono}
                  fontSize={24}
                  fill="#7ee787"
                  opacity={interpolate(local, [start + 6, start + 12], [0, 1], clamp)}
                >
                  {edge.label}
                </text>
              ) : null}
            </g>
          );
        }
        return (
          <g key={`${edge.from}-${edge.to}`}>
            {edge.dashed ? (
              <path
                d={`M ${a.x} ${a.y} L ${a.x + (b.x - a.x) * p} ${a.y + (b.y - a.y) * p}`}
                stroke={color}
                strokeWidth={3}
                strokeDasharray="10 9"
                opacity={0.8}
              />
            ) : (
              <Arrow x1={a.x} y1={a.y} x2={b.x} y2={b.y} color={color} progress={p} bend={0} />
            )}
            {edge.label ? (
              // Above a horizontal arrow, beside a vertical one: never on the line.
              <g opacity={interpolate(local, [start + 6, start + 12], [0, 1], clamp)}>
                <text
                  x={
                    Math.abs(b.x - a.x) > Math.abs(b.y - a.y)
                      ? mx
                      : b.x < a.x - 20
                        ? mx - 18
                        : mx + 18
                  }
                  y={Math.abs(b.x - a.x) > Math.abs(b.y - a.y) ? my - 18 : my + 8}
                  textAnchor={
                    Math.abs(b.x - a.x) > Math.abs(b.y - a.y)
                      ? "middle"
                      : b.x < a.x - 20
                        ? "end"
                        : "start"
                  }
                  fontFamily={mono}
                  fontSize={24}
                  fill={edge.dashed ? color : "#7ee787"}
                >
                  {edge.label}
                </text>
              </g>
            ) : null}
          </g>
        );
      })}

      {step.nodes.map((node) => {
        const q = appear(node.id);
        const w = width(node.id);
        const h = height(node.id);
        return (
          <g
            key={node.id}
            opacity={q}
            transform={`translate(${node.x} ${node.y}) scale(${0.92 + 0.08 * q})`}
          >
            <rect
              x={-w / 2}
              y={-h / 2}
              width={w}
              height={h}
              rx={20}
              fill={brand.bgElevated}
              stroke={node.color}
              strokeWidth={3.5}
            />
            <text
              x={0}
              y={node.sub ? -6 : 12}
              textAnchor="middle"
              fontFamily={sans}
              fontWeight={700}
              fontSize={36}
              fill={brand.fg}
            >
              {node.title}
            </text>
            {node.sub ? (
              <text
                x={0}
                y={34}
                textAnchor="middle"
                fontFamily={mono}
                fontSize={22}
                fill={brand.fgMuted}
              >
                {node.sub}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
};
