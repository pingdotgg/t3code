import { interpolate } from "remotion";
import type { PyramidStep } from "../../shared/intro.ts";
import { hand, mono, sans } from "../fonts.ts";
import { brand } from "../theme.ts";
import { drawProgress, TONE } from "./draw.tsx";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** Four bands, bottom first: slot 0 is the widest. */
const CX = 690;
const TOP = 196;
const BOTTOM = 944;
const WIDE = 1080;
const NARROW = 460;
const GAP = 12;
const SLOTS = 4;
const BAND = (BOTTOM - TOP - GAP * (SLOTS - 1)) / SLOTS;
const widthAt = (y: number) => NARROW + ((WIDE - NARROW) * (y - TOP)) / (BOTTOM - TOP);
const band = (slot: number) => {
  const bottom = BOTTOM - slot * (BAND + GAP);
  return { top: bottom - BAND, bottom, mid: bottom - BAND / 2 };
};
/** Where the notes beside the pyramid start. */
const NOTE_X = CX + WIDE / 2 + 70;
const SLICE_W = 420;
/** The observability column: right of the pyramid's widest band. */
const PILLAR_X = CX + WIDE / 2 + 70;
const PILLAR_W = 300;
/** The code column beside the pyramid: clear of its widest band, same left edge for every row. */
const CODE_X = 1225;
const CODE_SIZE = 22;
const CODE_LH = 34;

const DIM = 0.3;

type Brick = NonNullable<PyramidStep["bricks"]>[number];

/**
 * An application's layers, stacked as a pyramid. Layers rise in as they're
 * introduced; notes beside them, the bracket over them, the line that splits
 * them, a feature cut through them, and the modules that rebuild them come
 * and go by step.
 */
export const PyramidView = ({
  step,
  prev,
  local,
}: {
  step: PyramidStep;
  prev?: PyramidStep;
  local: number;
}) => {
  const t = interpolate(local, [0, 10], [0, 1], clamp);
  const lit = (s: PyramidStep | undefined, id: string) => !s?.lit || s.lit.includes(id);
  const blend = (now: number, then: number) => then + (now - then) * t;
  const had = (id: string) => !!prev?.layers.some((l) => l.id === id);
  const fresh = step.layers.filter((l) => !had(l.id));
  const noteKey = (n: { layer: string; text: string }) => `${n.layer}:${n.text}`;
  const oldNotes = new Set(prev?.side?.map(noteKey));
  const newNotes = (step.side ?? []).filter((n) => !oldNotes.has(noteKey(n)));
  const braceNew =
    !!step.brace && (prev?.brace?.text !== step.brace.text || prev?.brace?.sub !== step.brace.sub);
  const braceWas = !!prev?.brace;

  // Bands fade back when something is drawn over them.
  const covered = (s: PyramidStep | undefined) => (s?.bricks || s?.slice || s?.slices ? 0 : 1);
  const bandText = blend(covered(step), prev ? covered(prev) : covered(step));
  const bandFill = blend(
    step.bricks ? 0.25 : 1,
    prev ? (prev.bricks ? 0.25 : 1) : step.bricks ? 0.25 : 1,
  );

  const sliceIn = step.slice ? (prev?.slice ? 1 : interpolate(local, [2, 12], [0, 1], clamp)) : 0;
  const cutIn = step.cut
    ? prev?.cut?.under === step.cut.under
      ? 1
      : drawProgress(local, 6, 12)
    : 0;

  const brickKey = (b: Brick) => `${b.row}:${b.title}`;
  const oldBricks = new Set(prev?.bricks?.map(brickKey));
  const newBricks = (step.bricks ?? []).filter((b) => !oldBricks.has(brickKey(b)));

  return (
    <svg width={1920} height={1080} style={{ position: "absolute", left: 0, top: 0 }}>
      {step.layers.map((layer, slot) => {
        const { top, bottom, mid } = band(slot);
        const k = fresh.indexOf(layer);
        const q = k < 0 ? 1 : interpolate(local, [k * 4, k * 4 + 8], [0, 1], clamp);
        // With modules drawn over them, the bands are only a backdrop: never dimmed.
        const bandLit = (s: PyramidStep | undefined) => !!s?.bricks || lit(s, layer.id);
        const now = bandLit(step) ? 1 : DIM;
        const then = had(layer.id) ? (bandLit(prev) ? 1 : DIM) : now;
        const level = blend(now, then);
        const wt = widthAt(top);
        const wb = widthAt(bottom);
        const oldDetail = prev?.layers.find((l) => l.id === layer.id)?.detail;
        const detailIn =
          oldDetail === undefined || oldDetail === layer.detail
            ? 1
            : interpolate(local, [2, 10], [0, 1], clamp);
        return (
          <g key={layer.id} opacity={q * level} transform={`translate(0 ${(1 - q) * 30})`}>
            <path
              d={`M ${CX - wb / 2} ${bottom} L ${CX - wt / 2} ${top} L ${CX + wt / 2} ${top} L ${CX + wb / 2} ${bottom} Z`}
              fill={`${layer.color}1f`}
              fillOpacity={bandFill}
              stroke={layer.color}
              strokeOpacity={0.4 + 0.6 * bandFill}
              strokeWidth={3}
              strokeLinejoin="round"
            />
            <g opacity={bandText}>
              <text
                x={CX}
                y={mid - 6}
                textAnchor="middle"
                fontFamily={sans}
                fontWeight={700}
                fontSize={40}
                fill={brand.fg}
              >
                {layer.title}
              </text>
              <text
                x={CX}
                y={mid + 38}
                textAnchor="middle"
                fontFamily={mono}
                fontSize={24}
                fill={brand.fgMuted}
                opacity={detailIn}
              >
                {layer.detail}
              </text>
            </g>
          </g>
        );
      })}

      {step.cut
        ? (() => {
            const slot = step.layers.findIndex((l) => l.id === step.cut!.under);
            const y = band(slot).bottom + GAP / 2;
            const x1 = CX - widthAt(y) / 2 - 40;
            const x2 = NOTE_X - 30;
            return (
              <g>
                <path
                  d={`M ${x1} ${y} L ${x1 + (x2 - x1) * cutIn} ${y}`}
                  stroke={TONE.bad}
                  strokeWidth={5}
                  strokeDasharray="16 10"
                  strokeLinecap="round"
                />
                <g opacity={cutIn} fontFamily={hand} fontWeight={700} fontSize={46} fill={brand.fg}>
                  <text x={NOTE_X} y={y - 26}>
                    ↑ {step.cut.above}
                  </text>
                  <text x={NOTE_X} y={y + 58}>
                    ↓ {step.cut.below}
                  </text>
                </g>
              </g>
            );
          })()
        : null}

      {/* A feature cut vertically through the layers: one solid section per band. */}
      {step.slice
        ? (() => {
            const top = band(step.layers.length - 1).top;
            const x = CX - SLICE_W / 2;
            return (
              <g opacity={sliceIn}>
                {step.layers.map((layer, slot) => {
                  const b = band(slot);
                  const item = step.slice!.items[layer.id];
                  const level = blend(
                    lit(step, layer.id) ? 1 : DIM,
                    prev?.slice ? (lit(prev, layer.id) ? 1 : DIM) : 1,
                  );
                  return (
                    <g key={layer.id}>
                      <rect x={x} y={b.top} width={SLICE_W} height={BAND} fill={brand.bg} />
                      <rect
                        x={x}
                        y={b.top}
                        width={SLICE_W}
                        height={BAND}
                        fill={layer.color}
                        fillOpacity={0.16 * level}
                      />
                      {item ? (
                        <g opacity={level}>
                          <text
                            x={CX}
                            y={b.mid - 10}
                            textAnchor="middle"
                            fontFamily={mono}
                            fontSize={20}
                            fill={layer.color}
                          >
                            {layer.title.toLowerCase()}
                          </text>
                          <text
                            x={CX}
                            y={b.mid + 30}
                            textAnchor="middle"
                            fontFamily={sans}
                            fontWeight={700}
                            fontSize={32}
                            fill={brand.fg}
                          >
                            {item}
                          </text>
                        </g>
                      ) : null}
                    </g>
                  );
                })}
                <rect
                  x={x}
                  y={top}
                  width={SLICE_W}
                  height={BOTTOM - top}
                  rx={14}
                  fill="none"
                  stroke={TONE.good}
                  strokeWidth={4}
                />
                <text
                  x={CX}
                  y={BOTTOM + 58}
                  textAnchor="middle"
                  fontFamily={hand}
                  fontWeight={700}
                  fontSize={48}
                  fill={TONE.good}
                >
                  {step.slice.label}
                </text>
              </g>
            );
          })()
        : null}

      {/* Several slices side by side, widening with the pyramid: every module spans the same layers. */}
      {step.slices
        ? step.slices.map((sl, k) => {
            const n = step.slices!.length;
            const gap = 14;
            /** The slice's left and right edge at height y. */
            const edges = (y: number) => {
              const w = widthAt(y);
              const left = CX - w / 2;
              return [left + (k * w) / n + gap / 2, left + ((k + 1) * w) / n - gap / 2] as const;
            };
            const topY = band(step.layers.length - 1).top;
            const [tl, tr] = edges(topY);
            const [bl, br] = edges(BOTTOM);
            const q = prev?.slices?.some((p) => p.label === sl.label)
              ? 1
              : interpolate(local, [2 + k * 4, 10 + k * 4], [0, 1], clamp);
            return (
              <g key={sl.label} opacity={q} transform={`translate(0 ${(1 - q) * 18})`}>
                {step.layers.map((layer, slot) => {
                  const b = band(slot);
                  const [a1, a2] = edges(b.top);
                  const [c1, c2] = edges(b.bottom);
                  const item = sl.items[layer.id];
                  const [m1, m2] = edges(b.mid);
                  return (
                    <g key={layer.id}>
                      <path
                        d={`M ${a1} ${b.top} L ${a2} ${b.top} L ${c2} ${b.bottom} L ${c1} ${b.bottom} Z`}
                        fill={brand.bg}
                      />
                      <path
                        d={`M ${a1} ${b.top} L ${a2} ${b.top} L ${c2} ${b.bottom} L ${c1} ${b.bottom} Z`}
                        fill={layer.color}
                        fillOpacity={item ? 0.2 : 0.05}
                      />
                      {item ? (
                        <text
                          x={(m1 + m2) / 2}
                          y={b.mid + 9}
                          textAnchor="middle"
                          fontFamily={mono}
                          fontSize={22}
                          fill={brand.fg}
                        >
                          {item}
                        </text>
                      ) : null}
                    </g>
                  );
                })}
                <path
                  d={`M ${tl} ${topY} L ${tr} ${topY} L ${br} ${BOTTOM} L ${bl} ${BOTTOM} Z`}
                  fill="none"
                  stroke={TONE.good}
                  strokeWidth={3}
                  strokeLinejoin="round"
                />
                <text
                  x={(bl + br) / 2}
                  y={BOTTOM + 50}
                  textAnchor="middle"
                  fontFamily={hand}
                  fontWeight={700}
                  fontSize={40}
                  fill={TONE.good}
                >
                  {sl.label}
                </text>
              </g>
            );
          })
        : null}

      {(step.bricks ?? []).map((brick) => {
        const { top, bottom } = band(brick.row);
        const inRow = step.bricks!.filter((b) => b.row === brick.row);
        const i = brick.col ?? inRow.indexOf(brick);
        const n = brick.of ?? inRow.length;
        const rowW = widthAt(top) - 60;
        const gap = 18;
        const w = (rowW - gap * (n - 1)) / n;
        const x = CX - rowW / 2 + i * (w + gap);
        const y = top + 10;
        const h = bottom - top - 20;
        const k = newBricks.indexOf(brick);
        const q = k < 0 ? 1 : interpolate(local, [4 + k * 4, 12 + k * 4], [0, 1], clamp);
        const level = blend(
          lit(step, brick.title) ? 1 : DIM,
          prev?.bricks?.some((b) => brickKey(b) === brickKey(brick))
            ? lit(prev, brick.title)
              ? 1
              : DIM
            : 1,
        );
        return (
          <g key={brickKey(brick)} opacity={q * level} transform={`translate(0 ${(1 - q) * -40})`}>
            <rect
              x={x}
              y={y}
              width={w}
              height={h}
              rx={16}
              fill={brand.bgElevated}
              stroke={brick.color}
              strokeWidth={3.5}
            />
            <text
              x={x + w / 2}
              y={y + h / 2 - 4}
              textAnchor="middle"
              fontFamily={sans}
              fontWeight={700}
              fontSize={36}
              fill={brand.fg}
            >
              {brick.title}
            </text>
            <text
              x={x + w / 2}
              y={y + h / 2 + 34}
              textAnchor="middle"
              fontFamily={mono}
              fontSize={20}
              fill={brand.fgMuted}
            >
              {brick.detail}
            </text>
          </g>
        );
      })}

      {/* A column beside the pyramid: it spans every layer, and each layer feeds it. */}
      {step.pillar
        ? (() => {
            const pillar = step.pillar;
            const top = band(step.layers.length - 1).top;
            const x = PILLAR_X;
            const was = prev?.pillar;
            const q = was ? 1 : interpolate(local, [2, 12], [0, 1], clamp);
            const linesIn =
              was && was.lines.join() === pillar.lines.join()
                ? 1
                : interpolate(local, [6, 14], [0, 1], clamp);
            const mid = (top + BOTTOM) / 2;
            return (
              <g opacity={q} transform={`translate(${(1 - q) * 24} 0)`}>
                {step.layers.map((layer, slot) => {
                  const b = band(slot);
                  const from = CX + widthAt(b.mid) / 2 + 10;
                  return (
                    <path
                      key={layer.id}
                      d={`M ${from} ${b.mid} L ${x - 12} ${b.mid}`}
                      stroke={pillar.color}
                      strokeWidth={3}
                      strokeDasharray="8 8"
                      opacity={0.7}
                    />
                  );
                })}
                <rect
                  x={x}
                  y={top}
                  width={PILLAR_W}
                  height={BOTTOM - top}
                  rx={18}
                  fill={brand.bgElevated}
                  stroke={pillar.color}
                  strokeWidth={3.5}
                />
                <text
                  x={x + PILLAR_W / 2}
                  y={top + 64}
                  textAnchor="middle"
                  fontFamily={sans}
                  fontWeight={700}
                  fontSize={34}
                  fill={brand.fg}
                >
                  {pillar.title}
                </text>
                <g opacity={linesIn}>
                  {pillar.lines.map((line, i) => (
                    <text
                      key={line}
                      x={x + PILLAR_W / 2}
                      y={mid - ((pillar.lines.length - 1) * 44) / 2 + i * 44 + 10}
                      textAnchor="middle"
                      fontFamily={mono}
                      fontSize={24}
                      fill={brand.fgMuted}
                    >
                      {line}
                    </text>
                  ))}
                </g>
              </g>
            );
          })()
        : null}

      {(step.side ?? []).map((note) => {
        const slot = step.layers.findIndex((l) => l.id === note.layer);
        if (slot < 0) return null;
        const { mid } = band(slot);
        const k = newNotes.indexOf(note);
        const q = k < 0 ? 1 : interpolate(local, [4 + k * 4, 12 + k * 4], [0, 1], clamp);
        const color = TONE[note.tone ?? "neutral"];
        if (note.code) {
          // One left-aligned column beside the pyramid; each line keeps its place, and only
          // lines that weren't there before fade in.
          const lines =
            note.tokens ?? note.text.split("\n").map((text) => [{ text, color: brand.fg }]);
          const before = new Set(
            (prev?.side ?? [])
              .filter((n) => n.code && n.layer === note.layer)
              .flatMap((n) => n.text.split("\n")),
          );
          const y0 = mid + 8 - ((lines.length - 1) * CODE_LH) / 2;
          return (
            <g key={note.layer}>
              {lines.map((line, j) => {
                const raw = line.map((t) => t.text).join("");
                if (!raw.trim()) return null;
                const lq = before.has(raw) ? 1 : interpolate(local, [4, 12], [0, 1], clamp);
                return (
                  <text
                    key={raw}
                    x={CODE_X}
                    y={y0 + j * CODE_LH}
                    fontFamily={mono}
                    fontSize={CODE_SIZE}
                    opacity={lq}
                    transform={`translate(${(1 - lq) * 14} 0)`}
                    style={{ whiteSpace: "pre" }}
                  >
                    {line.map((t, k) => (
                      <tspan key={k} fill={t.color}>
                        {t.text}
                      </tspan>
                    ))}
                  </text>
                );
              })}
            </g>
          );
        }
        return (
          <g key={noteKey(note)} opacity={q} transform={`translate(${(1 - q) * 14} 0)`}>
            <text
              x={NOTE_X}
              y={mid + 14}
              fontFamily={hand}
              fontWeight={700}
              fontSize={44}
              fill={color}
            >
              {note.text}
            </text>
          </g>
        );
      })}

      {step.brace
        ? (() => {
            const shown = step.layers.length;
            const top = band(shown - 1).top;
            const bottom = BOTTOM;
            const x = NOTE_X - 20;
            const midY = (top + bottom) / 2;
            const p = braceNew && !braceWas ? drawProgress(local, 4, 12) : 1;
            const d = `M ${x} ${top} Q ${x + 28} ${top} ${x + 28} ${top + 40} L ${x + 28} ${midY - 30} Q ${x + 28} ${midY} ${x + 56} ${midY} Q ${x + 28} ${midY} ${x + 28} ${midY + 30} L ${x + 28} ${bottom - 40} Q ${x + 28} ${bottom} ${x} ${bottom}`;
            const label = braceNew ? interpolate(local, [8, 16], [0, 1], clamp) : 1;
            return (
              <g>
                <path
                  d={d}
                  fill="none"
                  stroke={TONE.good}
                  strokeWidth={4}
                  strokeLinecap="round"
                  strokeDasharray={3000}
                  strokeDashoffset={3000 * (1 - p)}
                />
                <g opacity={label}>
                  <text
                    x={x + 84}
                    y={midY - 4}
                    fontFamily={hand}
                    fontWeight={700}
                    fontSize={54}
                    fill={TONE.good}
                  >
                    {step.brace.text}
                  </text>
                  {step.brace.sub
                    ? step.brace.sub.split("\n").map((line, i) => (
                        <text
                          key={line}
                          x={x + 86}
                          y={midY + 44 + i * 40}
                          fontFamily={mono}
                          fontSize={26}
                          fill={brand.fgMuted}
                        >
                          {line}
                        </text>
                      ))
                    : null}
                </g>
              </g>
            );
          })()
        : null}
    </svg>
  );
};
