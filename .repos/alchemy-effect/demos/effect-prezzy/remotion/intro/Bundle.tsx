import { interpolate } from "remotion";
import type { BundlePanel } from "../../shared/intro.ts";
import { hand, mono, sans } from "../fonts.ts";
import { brand } from "../theme.ts";
import { TONE } from "./draw.tsx";

const WIDTH = 560;
/** The wall of clients stops here; the rest fade out under the note. */
const WALL_HEIGHT = 440;
/** Size at which the bar is full. */
const MAX_KB = 2000;

const formatSize = (kb: number) =>
  kb < 1000 ? `${Math.round(kb)} KB` : `${(kb / 1000).toFixed(1)} MB`;
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/**
 * The Worker bundle: its size, and a wall of every client it contains. Clients
 * the code actually calls are green; the rest pour in (or drain out) as the
 * bundle grows (or shrinks) between steps.
 */
export const BundleView = ({
  bundle,
  prev,
  x,
  labelY,
  top,
  local,
  delay,
}: {
  bundle: BundlePanel;
  prev?: BundlePanel;
  x: number;
  labelY: number;
  top: number;
  local: number;
  delay: number;
}) => {
  const before = new Set(prev?.items ?? []);
  const now = new Set(bundle.items);
  const added = bundle.items.filter((n) => !before.has(n));
  const growing = bundle.size > (prev?.size ?? 0);
  // The counter and bar run for as long as the clients take to pour in.
  const pour = Math.max(8, Math.min(30, added.length / 6));
  const t = interpolate(local, [delay, delay + pour], [0, 1], clamp);
  const eased = growing ? t * t : 1 - (1 - t) * (1 - t);
  const size =
    (prev?.size ?? bundle.size) + (bundle.size - (prev?.size ?? bundle.size)) * (prev ? eased : 1);
  const heavy = size > 500;
  const color = heavy ? TONE.bad : TONE.good;
  const used = new Set(bundle.used ?? []);
  // Everything that's on screen now or on the way out, in a stable order.
  // Clients on their way out stay in the layout only while they fade.
  const leaving = local < delay + 6 ? (prev?.items ?? []).filter((n) => !now.has(n)) : [];
  const all = [...leaving, ...bundle.items];
  const order = new Map(bundle.items.map((n, i) => [n, i]));
  const shown = [...new Set(all)].sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9));
  const extra = bundle.items.length - used.size;

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
        }}
      >
        {bundle.label}
      </div>
      <div style={{ position: "absolute", left: x, top, width: WIDTH }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 16 }}>
          <span
            style={{
              fontFamily: sans,
              fontWeight: 800,
              fontSize: 64,
              color,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {formatSize(size)}
          </span>
          <span style={{ fontFamily: mono, fontSize: 20, color: brand.fgMuted }}>
            {bundle.items.length} {bundle.items.length === 1 ? "client" : "clients"}
          </span>
        </div>
        <div
          style={{
            marginTop: 10,
            height: 14,
            borderRadius: 7,
            background: "rgba(255,255,255,0.08)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${Math.min(100, (size / MAX_KB) * 100)}%`,
              height: "100%",
              borderRadius: 7,
              background: color,
            }}
          />
        </div>
        <div
          style={{
            marginTop: 22,
            maxHeight: WALL_HEIGHT,
            overflow: "hidden",
            maskImage: "linear-gradient(to bottom, black 80%, transparent)",
            display: "flex",
            flexWrap: "wrap",
            columnGap: 12,
            rowGap: 2,
            fontFamily: mono,
            fontSize: 13,
            lineHeight: "17px",
          }}
        >
          {shown.map((name) => {
            const isUsed = used.has(name);
            let opacity = 1;
            if (!now.has(name)) opacity = 1 - interpolate(local, [delay, delay + 6], [0, 1], clamp);
            else if (!before.has(name) && prev) {
              const k = added.indexOf(name);
              const at = delay + (k / Math.max(1, added.length)) * pour;
              opacity = interpolate(local, [at, at + 3], [0, 1], clamp);
            }
            return (
              <span
                key={name}
                style={{
                  opacity: opacity * (isUsed ? 1 : 0.62),
                  color: isUsed ? TONE.good : brand.fgMuted,
                  fontWeight: isUsed ? 700 : 400,
                  fontSize: isUsed ? 18 : 13,
                }}
              >
                {name}
              </span>
            );
          })}
        </div>
        {bundle.note ? (
          <div
            style={{
              marginTop: 18,
              fontFamily: hand,
              fontWeight: 700,
              fontSize: 40,
              color,
              // Lands as the pour finishes.
              opacity: interpolate(local, [delay + pour - 4, delay + pour + 2], [0, 1], clamp),
            }}
          >
            {bundle.note.replace("{extra}", String(extra))}
          </div>
        ) : null}
      </div>
    </>
  );
};
