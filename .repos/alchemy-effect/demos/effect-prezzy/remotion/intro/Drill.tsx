import { interpolate } from "remotion";
import type { Drill } from "../../shared/intro.ts";
import { hand, mono } from "../fonts.ts";
import { brand } from "../theme.ts";
import { drawProgress, stroke, TONE, underlinePath } from "./draw.tsx";

const SIZE = 26;
const CW = SIZE * 0.6;
const TEXT_H = SIZE * 1.5;
const ROW = 74;

/** Split a line into plain text and occurrences of `name`. */
const parts = (line: string, name: string) =>
  line.split(new RegExp(`(\\b${name}\\b)`)).filter((p) => p.length > 0);

/**
 * A value threaded down a call chain: each call takes it as a parameter and
 * the thread shows it being handed from one layer to the next.
 */
export const DrillView = ({
  drill,
  x,
  labelY,
  top,
  local,
  delay,
}: {
  drill: Drill;
  x: number;
  labelY: number;
  top: number;
  local: number;
  delay: number;
}) => {
  const color = TONE.construct;
  const fade = (from: number, frames = 6) =>
    interpolate(local, [from, from + frames], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  const last = drill.lines.length - 1;
  // Where the value sits on each line, for the underline and the thread.
  const spots = drill.lines.map((line, i) => {
    const col = line.search(new RegExp(`\\b${drill.name}\\b`));
    const x0 = x + col * CW;
    const w = drill.name.length * CW;
    return { x: x0, w, cx: x0 + w / 2, top: top + i * ROW };
  });
  const lineAt = (i: number) => delay + i * 3;
  const underlineAt = (i: number) => delay + 4 + i * 4;

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
          opacity: fade(delay - 4),
        }}
      >
        {drill.label}
      </div>
      {drill.lines.map((line, i) => {
        const p = fade(lineAt(i));
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: x,
              top: top + i * ROW,
              height: TEXT_H,
              lineHeight: `${TEXT_H}px`,
              fontFamily: mono,
              fontSize: SIZE,
              whiteSpace: "pre",
              // Layers in between only pass it along; the last one uses it.
              color: i === last ? brand.fg : brand.fgMuted,
              opacity: p,
              transform: `translateY(${(1 - p) * -8}px)`,
            }}
          >
            {parts(line, drill.name).map((part, k) => (
              <span key={k} style={part === drill.name ? { color, fontWeight: 700 } : undefined}>
                {part}
              </span>
            ))}
          </div>
        );
      })}
      <svg
        width={1920}
        height={1080}
        style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }}
      >
        {spots.map((s, i) => (
          <g key={i}>
            {stroke(
              underlinePath(s.x, s.top + TEXT_H * 0.95, s.w, i * 5 + 3),
              color,
              drawProgress(local, underlineAt(i), 6),
              3,
            )}
            {i < last
              ? (() => {
                  const next = spots[i + 1]!;
                  const x1 = s.cx;
                  const y1 = s.top + TEXT_H + 6;
                  const x2 = next.cx;
                  const y2 = next.top - 4;
                  const p = drawProgress(local, underlineAt(i) + 3, 5);
                  const head = 9;
                  return (
                    <g opacity={0.8}>
                      {stroke(
                        `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`,
                        color,
                        p,
                        2.5,
                      )}
                      {p > 0.95
                        ? stroke(
                            `M ${x2 - head * 0.7} ${y2 - head} L ${x2} ${y2} L ${x2 + head * 0.7} ${y2 - head}`,
                            color,
                            1,
                            2.5,
                          )
                        : null}
                    </g>
                  );
                })()
              : null}
          </g>
        ))}
      </svg>
      {drill.note ? (
        <div
          style={{
            position: "absolute",
            left: x,
            top: top + drill.lines.length * ROW + 10,
            fontFamily: hand,
            fontWeight: 700,
            fontSize: 40,
            color,
            opacity: fade(underlineAt(last) + 6, 8),
          }}
        >
          {drill.note}
        </div>
      ) : null}
    </>
  );
};
