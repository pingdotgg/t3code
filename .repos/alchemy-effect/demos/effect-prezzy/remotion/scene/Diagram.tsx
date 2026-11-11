import { interpolate, spring, useVideoConfig } from "remotion";
import {
  TITLE_BAR,
  WINDOW,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type SceneCapture,
} from "../../shared/types.ts";
import { mono, sans } from "../fonts.ts";
import { brand } from "../theme.ts";
import { Window } from "./Desktop.tsx";
import type { SceneSchedule } from "./schedule.ts";

const PANEL = 430;
const CANVAS = { width: WINDOW.width - PANEL, height: WINDOW.height - TITLE_BAR };
const NODE = { width: 196, height: 88 };
const LEFT = 48;
const RIGHT = 48;

const PROVIDER_COLOR: Record<GraphNode["provider"], string> = {
  cloudflare: "#f38020",
  neon: "#00e599",
  axiom: "#8b7cf6",
  other: "#9d9d9d",
};

interface Placed extends GraphNode {
  x: number;
  y: number;
}

/** Columns by tier, nodes centred vertically within their column. */
const layout = (graph: Graph): Map<string, Placed> => {
  const placed = new Map<string, Placed>();
  const tiers = [...new Set(graph.nodes.map((n) => n.tier))].sort((a, b) => a - b);
  // Spread the used columns across the canvas.
  const column =
    tiers.length > 1
      ? Math.min(360, (CANVAS.width - LEFT - RIGHT - NODE.width) / (tiers.length - 1))
      : 0;
  // Centre the columns when they don't fill the canvas.
  const used = NODE.width + column * (tiers.length - 1);
  const offset = (CANVAS.width - used) / 2;
  const order = [
    "Web",
    "Api",
    "Db",
    "LinkRoom",
    "Clicks",
    "Pool",
    "Traces",
    "Logs",
    "Ingest",
    "Postgres",
    "Dashboard",
  ];
  const rank = (id: string) => (order.indexOf(id) < 0 ? 99 : order.indexOf(id));
  tiers.forEach((tier, index) => {
    const nodes = graph.nodes
      .filter((n) => n.tier === tier)
      .sort((a, b) => rank(a.id) - rank(b.id));
    const gap = nodes.length > 3 ? 40 : 64;
    const total = nodes.length * NODE.height + (nodes.length - 1) * gap;
    const top = (CANVAS.height - total) / 2;
    nodes.forEach((node, i) => {
      placed.set(node.id, {
        ...node,
        x: offset + index * column,
        y: top + i * (NODE.height + gap),
      });
    });
  });
  return placed;
};

interface DiagramState {
  graph: Graph | undefined;
  added: Set<string>;
  /** Frames since the current diagram beat started (Infinity: nothing animating). */
  local: number;
}

const diagramState = (capture: SceneCapture, plan: SceneSchedule, frame: number): DiagramState => {
  let state: DiagramState = { graph: capture.start.diagram, added: new Set(), local: Infinity };
  for (const segment of plan.segments) {
    if (segment.from > frame) break;
    const { beat } = segment;
    if (beat.kind !== "diagram") continue;
    state = {
      graph: beat.graph,
      added: new Set([...beat.addedNodes, ...beat.addedEdges]),
      local: frame - segment.from - segment.switchFrames,
    };
  }
  return state;
};

const Node = ({
  node,
  appear,
  highlight,
}: {
  node: Placed;
  appear: number;
  highlight: boolean;
}) => {
  const color = PROVIDER_COLOR[node.provider];
  return (
    <div
      style={{
        position: "absolute",
        left: node.x,
        top: node.y,
        width: NODE.width,
        height: NODE.height,
        borderRadius: 14,
        background: "#1c1a17",
        border: `1.5px solid ${highlight ? brand.moss : "rgba(255,255,255,0.12)"}`,
        boxShadow: highlight
          ? `0 0 0 4px ${brand.moss}33, 0 10px 30px rgba(0,0,0,0.4)`
          : "0 8px 24px rgba(0,0,0,0.35)",
        opacity: appear,
        transform: `scale(${0.85 + 0.15 * appear})`,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        fontFamily: sans,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 9, height: 9, borderRadius: 5, background: color, flex: "none" }} />
        <span style={{ color: brand.fg, fontSize: 23, fontWeight: 600, whiteSpace: "nowrap" }}>
          {node.id}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ color: brand.fgMuted, fontSize: 15, whiteSpace: "nowrap" }}>
          {node.kind}
        </span>
        <span
          style={{
            fontFamily: mono,
            fontSize: 11,
            letterSpacing: 1,
            textTransform: "uppercase",
            padding: "2px 7px",
            borderRadius: 6,
            color: node.location === "local" ? "#cfcfcf" : "#1a1206",
            background: node.location === "local" ? "rgba(255,255,255,0.1)" : brand.ember,
          }}
        >
          {node.location}
        </span>
      </div>
    </div>
  );
};

const edgePath = (from: Placed, to: Placed) => {
  if (to.x > from.x) {
    const x1 = from.x + NODE.width;
    const y1 = from.y + NODE.height / 2;
    const x2 = to.x;
    const y2 = to.y + NODE.height / 2;
    const mx = (x1 + x2) / 2;
    // Label near the target end so labels fanning out of one node don't collide.
    const t = 0.66;
    const bez = (a: number, b: number, c: number, d: number) =>
      (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t ** 2 * c + t ** 3 * d;
    return {
      d: `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`,
      label: { x: bez(x1, mx, mx, x2), y: bez(y1, y1, y2, y2) },
    };
  }
  // Backwards (e.g. a queue consumer delivering to its Worker): loop underneath.
  const x1 = from.x + NODE.width / 2;
  const y1 = from.y + NODE.height;
  const x2 = to.x + NODE.width / 2;
  const y2 = to.y + NODE.height;
  const dip = Math.max(y1, y2) + 90;
  return {
    d: `M ${x1} ${y1} C ${x1} ${dip}, ${x2} ${dip}, ${x2} ${y2}`,
    label: { x: (x1 + x2) / 2, y: dip - 14 },
  };
};

const EDGE_COLOR: Record<GraphEdge["kind"], string> = {
  binding: brand.moss,
  consumer: brand.ember,
  reference: "#8a8274",
};

export const Diagram = ({
  capture,
  plan,
  frame,
}: {
  capture: SceneCapture;
  plan: SceneSchedule;
  frame: number;
}) => {
  const { fps } = useVideoConfig();
  const state = diagramState(capture, plan, frame);
  const graph = state.graph;
  const placed = graph ? layout(graph) : new Map<string, Placed>();
  const addedNodes = graph?.nodes.filter((n) => state.added.has(n.id)) ?? [];
  const nodeAppear = (id: string) => {
    if (!state.added.has(id) || state.local === Infinity) return 1;
    const index = addedNodes.findIndex((n) => n.id === id);
    return spring({
      frame: state.local - 8 - index * 6,
      fps,
      config: { damping: 16, stiffness: 140 },
    });
  };
  const edgesStart = 8 + addedNodes.length * 6 + 8;
  const edgeDraw = (edge: GraphEdge, index: number) =>
    !state.added.has(edge.id) || state.local === Infinity
      ? 1
      : interpolate(state.local, [edgesStart + index * 6, edgesStart + index * 6 + 18], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
  const addedEdges = graph?.edges.filter((e) => state.added.has(e.id)) ?? [];
  const grants = (addedEdges.length > 0 ? addedEdges : (graph?.edges ?? [])).filter((e) => e.label);

  return (
    <Window title={graph ? `Architecture — ${graph.stage}` : "Architecture"} background="#141210">
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage: "radial-gradient(rgba(255,255,255,0.06) 1.2px, transparent 1.2px)",
          backgroundSize: "28px 28px",
        }}
      />
      {graph ? (
        <>
          <svg
            width={CANVAS.width}
            height={CANVAS.height}
            style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }}
          >
            <defs>
              {Object.entries(EDGE_COLOR).map(([kind, color]) => (
                <marker
                  key={kind}
                  id={`arrow-${kind}`}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
                </marker>
              ))}
            </defs>
            {graph.edges.map((edge) => {
              const from = placed.get(edge.from);
              const to = placed.get(edge.to);
              if (!from || !to) return null;
              const { d } = edgePath(from, to);
              const draw = edgeDraw(edge, addedEdges.indexOf(edge));
              const length = 1200;
              const color = EDGE_COLOR[edge.kind];
              return (
                <g key={edge.id} opacity={Math.min(1, draw * 1.5)}>
                  <path
                    d={d}
                    fill="none"
                    stroke={color}
                    strokeWidth={state.added.has(edge.id) ? 3 : 2}
                    strokeDasharray={edge.kind === "reference" ? "7 6" : `${length}`}
                    strokeDashoffset={edge.kind === "reference" ? 0 : length * (1 - draw)}
                    markerEnd={draw > 0.95 ? `url(#arrow-${edge.kind})` : undefined}
                  />
                </g>
              );
            })}
          </svg>
          <div
            style={{
              position: "absolute",
              left: 40,
              top: 28,
              display: "flex",
              gap: 22,
              fontFamily: sans,
              fontSize: 15,
              color: brand.fgMuted,
            }}
          >
            {(
              [
                ["binding", "binding"],
                ["consumer", "queue consumer"],
                ["reference", "reference (Output)"],
              ] as const
            ).map(([kind, text]) => (
              <span key={kind} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <svg width="34" height="10">
                  <line
                    x1="0"
                    y1="5"
                    x2="34"
                    y2="5"
                    stroke={EDGE_COLOR[kind]}
                    strokeWidth="3"
                    strokeDasharray={kind === "reference" ? "7 6" : undefined}
                  />
                </svg>
                {text}
              </span>
            ))}
            <span style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: 12 }}>
              <span
                style={{
                  fontFamily: mono,
                  fontSize: 11,
                  padding: "2px 7px",
                  borderRadius: 6,
                  background: "rgba(255,255,255,0.1)",
                  color: "#cfcfcf",
                }}
              >
                LOCAL
              </span>
              alchemy dev simulator
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  fontFamily: mono,
                  fontSize: 11,
                  padding: "2px 7px",
                  borderRadius: 6,
                  background: brand.ember,
                  color: "#1a1206",
                }}
              >
                CLOUD
              </span>
              really deployed
            </span>
          </div>
          {[...placed.values()].map((node) => (
            <Node
              key={node.id}
              node={node}
              appear={nodeAppear(node.id)}
              highlight={state.added.has(node.id) && state.local !== Infinity}
            />
          ))}
        </>
      ) : (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeItems: "center",
            color: brand.fgMuted,
            fontFamily: sans,
            fontSize: 22,
          }}
        >
          Nothing deployed yet
        </div>
      )}
      <div
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          width: PANEL,
          borderLeft: "1px solid rgba(255,255,255,0.08)",
          background: "rgba(20,17,13,0.92)",
          padding: "28px 28px",
          fontFamily: sans,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            fontFamily: mono,
            fontSize: 13,
            letterSpacing: 3,
            color: brand.moss,
            textTransform: "uppercase",
          }}
        >
          {addedEdges.length > 0 ? "New bindings & grants" : "Bindings & grants"}
        </div>
        {grants.length === 0 ? (
          <div style={{ marginTop: 20, color: brand.fgMuted, fontSize: 17, lineHeight: 1.5 }}>
            No bindings yet: the website only serves its own assets.
          </div>
        ) : null}
        <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 18 }}>
          {grants.slice(0, 7).map((edge, i) => (
            <div
              key={edge.id}
              style={{
                opacity:
                  state.local === Infinity
                    ? 1
                    : interpolate(
                        state.local,
                        [edgesStart + i * 8, edgesStart + i * 8 + 12],
                        [0, 1],
                        { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
                      ),
              }}
            >
              <div style={{ color: brand.fg, fontSize: 19, fontWeight: 600 }}>
                {edge.from} <span style={{ color: EDGE_COLOR[edge.kind] }}>→</span> {edge.to}
              </div>
              <div style={{ color: brand.fgMuted, fontSize: 15, marginTop: 3 }}>{edge.label}</div>
              {edge.grant ? (
                <div
                  style={{
                    marginTop: 8,
                    fontFamily: mono,
                    fontSize: 13,
                    lineHeight: 1.45,
                    color: "#d6cdb8",
                    background: "rgba(255,255,255,0.05)",
                    border: "1px solid rgba(255,255,255,0.07)",
                    borderRadius: 8,
                    padding: "8px 10px",
                    wordBreak: "break-all",
                  }}
                >
                  {edge.grant}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </Window>
  );
};
