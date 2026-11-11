import type { ReactNode } from "react";
import { interpolate } from "remotion";
import type { ReqItem, ReqPanel } from "../../shared/intro.ts";
import { mono, sans } from "../fonts.ts";
import { brand } from "../theme.ts";
import { TONE } from "./draw.tsx";

/** Vertical space per requirement. */
const ROW = 58;
/** Vertical space for a part's heading, and the gap above it. */
const HEADING = 40;
const GAP = 22;

/** The editor theme's colors for types and punctuation, so Req reads as code. */
const TYPE = "#4ec9b0";
const PUNCT = "#d4d4d4";
const SIZE = 26;

/** One member of the union: `| Name`, with a note beside it. */
const Row = ({ item }: { item: ReqItem }) => {
  const state = item.state ?? "open";
  const noteColor = state === "met" ? TONE.good : state === "bad" ? TONE.bad : brand.fgMuted;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
      <div
        style={{
          fontFamily: mono,
          fontSize: SIZE,
          whiteSpace: "pre",
          opacity: state === "met" ? 0.45 : 1,
        }}
      >
        <span style={{ color: PUNCT }}>| </span>
        <span
          style={{
            color: state === "bad" ? TONE.bad : TYPE,
            textDecoration: state === "met" ? "line-through" : undefined,
            textDecorationColor: TONE.good,
            textDecorationThickness: 2,
          }}
        >
          {item.name}
        </span>
      </div>
      {item.note ? (
        <div
          style={{
            fontFamily: sans,
            fontSize: 18,
            lineHeight: 1.35,
            color: noteColor,
            whiteSpace: "pre",
          }}
        >
          {state === "met" ? `✓ ${item.note}` : state === "bad" ? `✗ ${item.note}` : item.note}
        </div>
      ) : null}
    </div>
  );
};

const Never = () => <div style={{ fontFamily: mono, fontSize: SIZE, color: TYPE }}>never</div>;

const Heading = ({ text }: { text: string }) => (
  <div style={{ fontFamily: mono, fontSize: 20, color: brand.fgMuted }}>{text}</div>
);

type Entry =
  | { key: string; y: number; kind: "item"; item: ReqItem }
  | { key: string; y: number; kind: "never" }
  | { key: string; y: number; kind: "heading"; text: string };

/**
 * Where each line of the panel sits. Keys are stable across steps, so a
 * requirement that moves from one part to another glides there.
 */
const layout = (req: ReqPanel, top: number): { entries: Entry[]; bottom: number } => {
  const entries: Entry[] = [];
  let y = top;
  const list = (items: ReqItem[], section: string) => {
    if (items.length === 0) {
      entries.push({ key: `never:${section}`, y, kind: "never" });
      y += ROW;
    }
    for (const item of items) {
      entries.push({ key: `item:${item.name}`, y, kind: "item", item });
      y += ROW;
    }
  };
  list(req.items, "");
  for (const part of req.parts ?? []) {
    y += GAP;
    entries.push({ key: `heading:${part.label}`, y, kind: "heading", text: part.label });
    y += HEADING;
    list(part.items, part.label);
  }
  return { entries, bottom: y };
};

/** The panel's height below `top`, so other things can sit under it. */
export const reqHeight = (req: ReqPanel) => layout(req, 0).bottom;

const same = (a: Entry, b: Entry) =>
  a.kind !== "item" ||
  b.kind !== "item" ||
  ((a.item.state ?? "open") === (b.item.state ?? "open") && a.item.note === b.item.note);

const content = (e: Entry): ReactNode =>
  e.kind === "item" ? (
    <Row item={e.item} />
  ) : e.kind === "never" ? (
    <Never />
  ) : (
    <Heading text={e.text} />
  );

/**
 * The requirements (Effect's `Req`) of the code on screen, written as the
 * union type they are. New members slide in, moved members glide, changed
 * members cross-fade, and removed members fade out.
 */
export const ReqView = ({
  req,
  prev,
  x,
  labelY,
  top,
  local,
  delay,
}: {
  req: ReqPanel;
  prev?: ReqPanel;
  x: number;
  labelY: number;
  top: number;
  local: number;
  delay: number;
}) => {
  const p = interpolate(local, [delay, delay + 7], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const now = layout(req, top).entries;
  const before = prev ? layout(prev, top).entries : [];
  const at = (key: string) => before.find((e) => e.key === key);
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: x,
          top: labelY,
          fontFamily: mono,
          fontSize: 22,
          color: brand.fgMuted,
          opacity: prev && prev.label === req.label ? 1 : p,
        }}
      >
        {req.label}
      </div>
      {now.map((e) => {
        const old = at(e.key);
        if (!old) {
          return (
            <div
              key={e.key}
              style={{
                position: "absolute",
                left: x,
                top: e.y,
                opacity: p,
                transform: `translateX(${(1 - p) * 18}px)`,
              }}
            >
              {content(e)}
            </div>
          );
        }
        const y = old.y + (e.y - old.y) * p;
        if (same(old, e)) {
          return (
            <div key={e.key} style={{ position: "absolute", left: x, top: y }}>
              {content(e)}
            </div>
          );
        }
        return (
          <div key={e.key}>
            {/* Out, then in: overlapping text of different lengths is unreadable. */}
            <div style={{ position: "absolute", left: x, top: y, opacity: Math.max(0, 1 - p * 2) }}>
              {content(old)}
            </div>
            <div style={{ position: "absolute", left: x, top: y, opacity: Math.max(0, p * 2 - 1) }}>
              {content(e)}
            </div>
          </div>
        );
      })}
      {before
        .filter((e) => !now.some((n) => n.key === e.key))
        .map((e) => (
          <div
            key={`gone-${e.key}`}
            style={{ position: "absolute", left: x, top: e.y, opacity: 1 - p }}
          >
            {content(e)}
          </div>
        ))}
    </>
  );
};
