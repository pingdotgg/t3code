import { interpolate } from "remotion";
import type { MiniGraph, MiniNode } from "../../shared/intro.ts";
import { hand, mono, sans } from "../fonts.ts";
import { brand, vscode } from "../theme.ts";
import { Arrow, drawProgress, TONE } from "./draw.tsx";

/** The drawing area, right of the code and above the caption band. */
const AREA = { x: 1090, y: 250, width: 720 };
const NODE = { w: 230, h: 84 };

const fade = (local: number, delay: number, frames = 7) =>
  interpolate(local, [delay, delay + frames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

/** Where a line from a node's centre towards (dx, dy) leaves its box. */
const exit = (n: { x: number; y: number }, dx: number, dy: number, pad = 8) => {
  const hw = NODE.w / 2 + pad;
  const hh = NODE.h / 2 + pad;
  const t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  return { x: n.x + dx * t, y: n.y + dy * t };
};

/** Where an arc into the drawing should land: the left edge of a node, or of an edge's label. */
export const graphAnchor = (
  graph: MiniGraph,
  to: { node: string } | { edge: [string, string] },
) => {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  if ("node" in to) {
    const n = byId.get(to.node);
    return n ? { x: AREA.x + n.x - NODE.w / 2 - 6, y: AREA.y + n.y } : undefined;
  }
  const a = byId.get(to.edge[0]);
  const b = byId.get(to.edge[1]);
  const e = graph.edges.find((x) => x.from === to.edge[0] && x.to === to.edge[1]);
  if (!a || !b || !e) return undefined;
  const s = exit(a, b.x - a.x, b.y - a.y);
  const t = exit(b, a.x - b.x, a.y - b.y);
  const lw = (e.label?.length ?? 0) * 12.6 + 26;
  return { x: AREA.x + (s.x + t.x) / 2 - lw / 2 - 6, y: AREA.y + (s.y + t.y) / 2 };
};

type Edge = MiniGraph["edges"][number];
const edgeKey = (e: Edge) => `${e.from}->${e.to}`;

/** What changed in `graph` since `prev`: that stays bright, everything else dims. */
const focusOf = (graph: MiniGraph | undefined, prev: MiniGraph | undefined) => {
  const before = new Map(prev?.nodes.map((n) => [n.id, n]));
  const old = new Map(prev?.edges.map((e) => [edgeKey(e), e]));
  const edge = (e: Edge) => {
    const was = old.get(edgeKey(e));
    return !!prev && (!was || was.tone !== e.tone || was.label !== e.label);
  };
  const node = (id: string) => {
    const n = graph?.nodes.find((x) => x.id === id);
    const was = before.get(id);
    if (!prev || !n) return false;
    const own = !was || (n.notes ?? []).some((note) => !was.notes?.includes(note));
    // The ends of a changed connection stay bright too.
    return own || (graph?.edges ?? []).some((e) => edge(e) && (e.from === id || e.to === id));
  };
  const card = (text: string) => !!prev && !prev.cards?.some((c) => c.text === text);
  const any =
    !!graph &&
    !!prev &&
    (graph.nodes.some((n) => node(n.id)) ||
      graph.edges.some(edge) ||
      (graph.cards ?? []).some((c) => card(c.text)));
  const ownNode = (id: string) => {
    const n = graph?.nodes.find((x) => x.id === id);
    const was = before.get(id);
    return !!prev && !!n && (!was || (n.notes ?? []).some((note) => !was.notes?.includes(note)));
  };
  return { any, node, ownNode, edge, card };
};

/** Brightness now, and at the end of the previous step, so unchanged parts don't flicker. */
const DIM = 0.4;
const level = (focus: { any: boolean }, on: boolean) => (focus.any ? (on ? 1 : DIM) : 1);

/**
 * Draws the program's architecture as it stands at this step. Anything new
 * since the previous step animates in; nodes that moved glide to their new
 * place, so the picture evolves with the code instead of cutting.
 */
export const MiniGraphView = ({
  graph,
  prev,
  prev2,
  local,
  delay,
}: {
  graph: MiniGraph;
  prev?: MiniGraph;
  /** The step before `prev`: tells us what was dimmed when this step began. */
  prev2?: MiniGraph;
  local: number;
  delay: number;
}) => {
  const glide = interpolate(local, [0, 8], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: (t) => 1 - (1 - t) ** 3,
  });
  const before = new Map(prev?.nodes.map((n) => [n.id, n]));
  const placed = new Map<string, MiniNode>(
    graph.nodes.map((n) => {
      const was = before.get(n.id);
      return [
        n.id,
        was ? { ...n, x: was.x + (n.x - was.x) * glide, y: was.y + (n.y - was.y) * glide } : n,
      ];
    }),
  );
  const oldEdges = new Set(prev?.edges.map((e) => `${e.from}->${e.to}`));
  const oldLabels = new Set(prev?.edges.map((e) => `${e.from}->${e.to}:${e.label}`));
  const oldCards = new Set(prev?.cards?.map((c) => c.text));
  const newNodes = graph.nodes.filter((n) => !before.has(n.id));
  const edgeStart = delay + newNodes.length * 2;
  const cardStart =
    edgeStart + graph.edges.filter((e) => !oldEdges.has(`${e.from}->${e.to}`)).length * 3 + 3;
  const graphBottom = Math.max(
    ...graph.nodes.map((n) => n.y + NODE.h / 2 + (n.notes?.length ?? 0) * 38),
    0,
  );

  // What changed since the previous step stays bright (and green); the rest dims.
  // Each part moves from how it looked at the end of the previous step, so
  // parts that stay dim (or stay bright) don't move at all.
  const now = focusOf(graph, prev);
  const then = focusOf(prev, prev2);
  const t = fade(local, 0, 8);
  const brightness = (on: boolean, was: boolean) => {
    const from = level(then, was);
    return from + (level(now, on) - from) * t;
  };
  const glow = fade(local, delay, 6);

  let newEdge = 0;
  let newCard = 0;
  return (
    <div
      style={{ position: "absolute", left: AREA.x, top: AREA.y, width: AREA.width, height: 820 }}
    >
      <svg
        width={AREA.width}
        height={820}
        style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }}
      >
        {graph.edges.map((e) => {
          const a = placed.get(e.from);
          const b = placed.get(e.to);
          if (!a || !b) return null;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const s = exit(a, dx, dy);
          const t = exit(b, -dx, -dy);
          const isNew = !oldEdges.has(`${e.from}->${e.to}`);
          const changed = now.edge(e);
          const prevEdge = prev?.edges.find((x) => edgeKey(x) === edgeKey(e));
          const opacity = brightness(changed, !!prevEdge && then.edge(prevEdge));
          const progress = isNew ? drawProgress(local, edgeStart + newEdge++ * 3, 8) : 1;
          // The permission sits on the arrow, a little past its middle.
          const lx = s.x + (t.x - s.x) * 0.5;
          const ly = s.y + (t.y - s.y) * 0.5;
          const lw = (e.label?.length ?? 0) * 12.6 + 26;
          const labelIn =
            isNew || !oldLabels.has(`${e.from}->${e.to}:${e.label}`)
              ? fade(local, edgeStart + 5, 5)
              : 1;
          return (
            <g key={`${e.from}->${e.to}`} opacity={opacity}>
              <Arrow
                x1={s.x}
                y1={s.y}
                x2={t.x}
                y2={t.y}
                color={
                  e.tone === "bad"
                    ? TONE.bad
                    : changed
                      ? "#7ee787"
                      : e.tone
                        ? TONE[e.tone]
                        : brand.fgMuted
                }
                progress={progress}
                bend={0}
              />
              {e.label ? (
                <g opacity={labelIn}>
                  <rect
                    x={lx - lw / 2}
                    y={ly - 18}
                    width={lw}
                    height={36}
                    rx={18}
                    fill="#14110d"
                    stroke={changed ? "#7ee787" : TONE.construct}
                    strokeWidth={2}
                  />
                  <text
                    x={lx}
                    y={ly + 7}
                    textAnchor="middle"
                    fontFamily={mono}
                    fontSize={21}
                    fill={changed ? "#7ee787" : "#d4d4d4"}
                  >
                    {e.label}
                  </text>
                </g>
              ) : null}
            </g>
          );
        })}
        {graph.frame
          ? (() => {
              // Everything drawn so far: the boxes and what's listed under them.
              const xs = graph.nodes.flatMap((n) => [n.x - NODE.w / 2, n.x + NODE.w / 2]);
              const ys = graph.nodes.flatMap((n) => [
                n.y - NODE.h / 2,
                n.y + NODE.h / 2 + (n.notes?.length ?? 0) * 38,
              ]);
              const x = Math.min(...xs) - 26;
              const y = Math.min(...ys) - 30;
              const w = Math.max(...xs) + 26 - x;
              const h = Math.max(...ys) + 26 - y;
              const color = TONE[graph.frame.tone ?? "construct"];
              const q = prev?.frame ? 1 : fade(local, delay, 8);
              return (
                <g opacity={q}>
                  <rect
                    x={x}
                    y={y}
                    width={w}
                    height={h}
                    rx={22}
                    fill={`${color}0d`}
                    stroke={color}
                    strokeWidth={2.5}
                    strokeDasharray="10 8"
                  />
                  {/* Top-right, clear of anything arriving from above. */}
                  <rect
                    x={x + w - 46 - graph.frame.label.length * 13.2}
                    y={y - 16}
                    width={graph.frame.label.length * 13.2 + 24}
                    height={32}
                    rx={8}
                    fill="#14110d"
                  />
                  <text
                    x={x + w - 34 - graph.frame.label.length * 13.2}
                    y={y + 8}
                    fill={color}
                    fontFamily={mono}
                    fontSize={22}
                    fontWeight={700}
                  >
                    {graph.frame.label}
                  </text>
                </g>
              );
            })()
          : null}
        {(graph.groups ?? []).map((group) => {
          const members = graph.nodes.filter((n) => group.nodes.includes(n.id));
          if (!members.length) return null;
          const xs = members.flatMap((n) => [n.x - NODE.w / 2, n.x + NODE.w / 2]);
          const ys = members.flatMap((n) => [
            n.y - NODE.h / 2,
            n.y + NODE.h / 2 + (n.notes?.length ?? 0) * 38,
          ]);
          const x = Math.min(...xs) - 30;
          const y = Math.min(...ys) - 44;
          const w = Math.max(...xs) + 30 - x;
          const h = Math.max(...ys) + 26 - y;
          const color = TONE[group.tone ?? "construct"];
          const q = prev?.groups?.some((g) => g.label === group.label) ? 1 : fade(local, delay, 8);
          return (
            <g key={group.label} opacity={q}>
              <rect
                x={x}
                y={y}
                width={w}
                height={h}
                rx={22}
                fill={`${color}0d`}
                stroke={color}
                strokeWidth={2.5}
              />
              <text
                x={x + w / 2}
                y={y + 30}
                textAnchor="middle"
                fill={color}
                fontFamily={mono}
                fontSize={22}
                fontWeight={700}
              >
                {group.label}
              </text>
            </g>
          );
        })}
        {graph.incoming
          ? (() => {
              // Requests stream into the node from above, from outside the architecture.
              const n = placed.get(graph.incoming.to)!;
              const color = TONE[graph.incoming.tone ?? "runtime"];
              const isNew = prev?.incoming?.to !== graph.incoming.to;
              const p = isNew ? drawProgress(local, delay + 3, 8) : 1;
              const top = n.y - NODE.h / 2;
              const y1 = top - 250;
              const y2 = top - 12;
              const dots = [0, 1, 2].map((k) => ((local + k * 16) % 48) / 48);
              return (
                <g opacity={isNew ? fade(local, delay + 3, 6) : 1}>
                  <Arrow x1={n.x} y1={y1} x2={n.x} y2={y2} color={color} progress={p} bend={0} />
                  {p >= 1
                    ? dots.map((d, k) => (
                        <circle
                          key={k}
                          cx={n.x}
                          cy={y1 + (y2 - y1 - 16) * d}
                          r={7}
                          fill={color}
                          opacity={Math.sin(Math.PI * d)}
                        />
                      ))
                    : null}
                  <text
                    x={n.x + 22}
                    y={y1 + 8}
                    fill={color}
                    fontFamily={mono}
                    fontSize={22}
                    fontWeight={700}
                  >
                    {graph.incoming.label}
                  </text>
                </g>
              );
            })()
          : null}
        {(graph.labels ?? []).map((label) => {
          const isNew = !prev?.labels?.some((l) => l.text === label.text);
          const color = TONE[label.tone ?? "construct"];
          return (
            <g key={label.text}>
              <text
                x={label.x}
                y={label.y}
                textAnchor="middle"
                fill={color}
                fontFamily={hand}
                fontWeight={700}
                fontSize={40}
                opacity={isNew ? fade(local, delay + 4) : 1}
              >
                {label.text.split("\n").map((line, i) => (
                  <tspan key={i} x={label.x} dy={i === 0 ? 0 : 44}>
                    {line}
                  </tspan>
                ))}
              </text>
              {(label.arrows ?? []).map((a, i) => (
                <Arrow
                  key={i}
                  x1={a.from[0]}
                  y1={a.from[1]}
                  x2={a.to[0]}
                  y2={a.to[1]}
                  color={color}
                  progress={isNew ? drawProgress(local, delay + 6 + i * 3, 8) : 1}
                  bend={0.15}
                />
              ))}
            </g>
          );
        })}
      </svg>
      {graph.nodes.map((n) => {
        const p = placed.get(n.id)!;
        const isNew = !before.has(n.id);
        const changed = now.ownNode(n.id);
        // Grow in only when new; dimming changes opacity, never size.
        const grow = isNew ? fade(local, delay + newNodes.indexOf(n) * 2) : 1;
        // A hypothetical node is the point of its step: never dim it.
        const opacity = grow * (n.ghost ? 1 : brightness(now.node(n.id), then.node(n.id)));
        // A glow for the box that changed; last step's glow fades out instead of popping.
        const glowing = changed ? glow : then.ownNode(n.id) ? 1 - t : 0;
        const oldNotes = new Set(before.get(n.id)?.notes);
        return (
          <div key={n.id}>
            <div
              style={{
                position: "absolute",
                left: p.x - NODE.w / 2,
                top: p.y - NODE.h / 2,
                width: NODE.w,
                height: NODE.h,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 12,
                borderRadius: 18,
                border: `3px ${n.ghost ? "dashed" : "solid"} ${n.color}`,
                background: n.ghost ? "transparent" : "#1c1a17",
                boxShadow:
                  glowing > 0
                    ? `0 0 0 ${5 * glowing}px ${n.ghost ? "rgba(255,123,114,0.45)" : "rgba(126,231,135,0.45)"}, 0 0 ${36 * glowing}px ${n.ghost ? "rgba(255,123,114,0.4)" : "rgba(126,231,135,0.4)"}, 0 12px 34px rgba(0,0,0,0.45)`
                    : "0 12px 34px rgba(0,0,0,0.45)",
                opacity,
                transform: `scale(${0.9 + 0.1 * grow})`,
                fontFamily: sans,
                fontSize: 34,
                fontWeight: 600,
                color: brand.fg,
              }}
            >
              <span style={{ width: 12, height: 12, borderRadius: 6, background: n.color }} />
              {n.title}
            </div>
            {(n.notes ?? []).map((note, i) => {
              const fresh = !oldNotes.has(note);
              const q = fresh ? fade(local, delay + 3 + i * 2, 6) : 1;
              return (
                <div
                  key={note}
                  style={{
                    position: "absolute",
                    left: p.x - NODE.w / 2,
                    top: p.y + NODE.h / 2 + 10 + i * 38,
                    width: NODE.w,
                    padding: "2px 12px",
                    fontFamily: mono,
                    fontSize: 22,
                    color: fresh ? "#7ee787" : brand.fgMuted,
                    background: fresh ? "rgba(46,160,67,0.18)" : undefined,
                    borderLeft: fresh ? "3px solid #2ea043" : undefined,
                    opacity: q,
                  }}
                >
                  {note}
                </div>
              );
            })}
          </div>
        );
      })}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: graphBottom + 50,
          width: AREA.width,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        {(graph.cards ?? []).map((card) => {
          const isNew = !oldCards.has(card.text);
          const q =
            (isNew ? fade(local, cardStart + newCard++ * 3) : 1) *
            brightness(now.card(card.text), then.card(card.text));
          const color = TONE[card.tone ?? "construct"];
          return (
            <div
              key={card.text}
              style={{
                padding: "12px 18px",
                borderRadius: 12,
                background: vscode.editorBg,
                border: `2px solid ${color}`,
                fontFamily: mono,
                fontSize: 26,
                color: "#d4d4d4",
                opacity: q,
                transform: `translateX(${(1 - q) * 16}px)`,
              }}
            >
              {card.text}
            </div>
          );
        })}
      </div>
    </div>
  );
};
