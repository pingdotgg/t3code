import type { ReactNode } from "react";
import { Easing, interpolate } from "remotion";
import type { RollStep, Token } from "../../shared/intro.ts";
import { mono, sans } from "../fonts.ts";
import { brand } from "../theme.ts";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const LINE = 1.55;
const CHAR = 0.6;
const GREEN = "#7ee787";

/** The tokens of `line` between two columns. */
const slice = (line: Token[], from: number, to: number): Token[] => {
  const out: Token[] = [];
  let col = 0;
  for (const token of line) {
    const a = Math.max(from, col);
    const b = Math.min(to, col + token.text.length);
    if (b > a) out.push({ ...token, text: token.text.slice(a - col, b - col) });
    col += token.text.length;
  }
  return out;
};
const length = (tokens: Token[]) => tokens.reduce((n, t) => n + t.text.length, 0);
const text = (tokens: Token[]) => tokens.map((t) => t.text).join("");

const Tokens = ({ tokens }: { tokens: Token[] }) => (
  <>
    {tokens.map((t, i) => (
      <span key={i} style={{ color: t.color, fontWeight: t.bold ? 700 : undefined }}>
        {t.text}
      </span>
    ))}
  </>
);

/**
 * Code that stays still while its slots roll to their next values: the old
 * value slides up and out, the new one slides up into place, and the slot's
 * width eases between the two so the rest of the line shifts smoothly.
 */
export const RollView = ({
  step,
  prev,
  local,
}: {
  step: RollStep;
  prev?: RollStep;
  local: number;
}) => {
  const same = prev?.group === step.group ? prev : undefined;
  const size = step.fontSize;
  const lh = size * LINE;
  const t = interpolate(local, [0, 12], [0, 1], {
    ...clamp,
    easing: Easing.bezier(0.3, 0, 0.1, 1),
  });
  const enter = same ? 1 : interpolate(local, [0, 8], [0, 1], clamp);

  // Same place as every code slide: file label at the top-left of the code area, code
  // below it. Nothing is centred, so the code never moves from one step to the next.
  const widest = Math.max(...step.lines.map(length));
  const codeW = widest * size * CHAR;
  const gap = 90;
  const left = 140;
  const top = 260;
  const labelTop = 170;

  // A spin: the slot runs through every value in `spin.through` and lands on its own,
  // fast at first and settling like a slot machine. `pos` is how far along the strip it is.
  const spin = step.spin;
  const spinLen = spin ? spin.through.length + 1 : 0;
  const pos = spin
    ? spinLen *
      interpolate(local, [0, step.frames - 6], [0, 1], {
        ...clamp,
        easing: Easing.bezier(0.15, 0.55, 0.25, 1),
      })
    : 0;

  const renderLine = (line: Token[], i: number) => {
    const here = step.slots.map((slot, k) => ({ slot, k })).filter(({ slot }) => slot.line === i);
    const parts: ReactNode[] = [];
    let col = 0;
    for (const { slot, k } of here) {
      parts.push(<Tokens key={`f${k}`} tokens={slice(line, col, slot.start)} />);
      const now = slice(line, slot.start, slot.end);
      const was = same?.slots[k]
        ? slice(same.lines[same.slots[k]!.line]!, same.slots[k]!.start, same.slots[k]!.end)
        : now;
      if (spin && spin.slot === k) {
        const color = now[0]?.color ?? brand.fg;
        const strip: Token[][] = [was, ...spin.through.map((text) => [{ text, color }]), now];
        const j = Math.min(Math.floor(pos), strip.length - 2);
        const f = pos - j;
        const width = length(strip[j]!) + (length(strip[j + 1]!) - length(strip[j]!)) * f;
        parts.push(
          <span
            key={`s${k}`}
            style={{
              display: "inline-block",
              verticalAlign: "top",
              width: `${width * CHAR * size}px`,
              height: lh,
              overflow: "hidden",
              background: `rgba(126, 231, 135, ${pos < spinLen ? 0.3 : 0.12})`,
              boxShadow: `inset 0 -3px 0 ${GREEN}`,
              borderRadius: 6,
            }}
          >
            <span style={{ display: "block", transform: `translateY(${-pos * lh}px)` }}>
              {strip.map((tokens, n) => (
                <span key={n} style={{ display: "block", height: lh }}>
                  <Tokens tokens={tokens} />
                </span>
              ))}
            </span>
          </span>,
        );
        col = slot.end;
        continue;
      }
      const rolling = text(was) !== text(now);
      const p = rolling ? t : 1;
      const width = length(was) + (length(now) - length(was)) * p;
      // Lit while it rolls in or out; a slot that stays put is plain code.
      const lit = step.slots[k]!.active ? 1 : 0;
      const glow = lit * (rolling ? 0.12 + 0.2 * Math.sin(Math.PI * p) : 0.12);
      parts.push(
        <span
          key={`s${k}`}
          style={{
            display: "inline-block",
            verticalAlign: "top",
            width: `${width * CHAR * size}px`,
            height: lh,
            overflow: "hidden",
            background: `rgba(126, 231, 135, ${glow})`,
            boxShadow: lit ? `inset 0 -3px 0 ${GREEN}` : undefined,
            borderRadius: 6,
          }}
        >
          <span style={{ display: "block", transform: `translateY(${rolling ? -p * lh : -lh}px)` }}>
            <span style={{ display: "block", height: lh }}>
              <Tokens tokens={was} />
            </span>
            <span style={{ display: "block", height: lh }}>
              <Tokens tokens={now} />
            </span>
          </span>
        </span>,
      );
      col = slot.end;
    }
    parts.push(<Tokens key="end" tokens={slice(line, col, Infinity)} />);
    return (
      <div key={i} style={{ height: lh, whiteSpace: "pre" }}>
        {parts}
      </div>
    );
  };

  const besideChanged =
    !!step.beside &&
    step.beside.lines.map(text).join("\n") !== same?.beside?.lines.map(text).join("\n");
  const besideIn = besideChanged ? interpolate(local, [6, 16], [0, 1], clamp) : 1;

  return (
    <div style={{ position: "absolute", inset: 0, opacity: enter }}>
      {step.file ? (
        <div
          style={{
            position: "absolute",
            left: 110,
            top: labelTop,
            fontFamily: mono,
            fontSize: 22,
            color: brand.fgMuted,
          }}
        >
          {step.file}
        </div>
      ) : null}
      <div
        style={{
          position: "absolute",
          left,
          top,
          fontFamily: mono,
          fontSize: size,
          lineHeight: `${lh}px`,
          color: brand.fg,
        }}
      >
        {step.lines.map(renderLine)}
      </div>

      {step.beside ? (
        <div
          style={{
            position: "absolute",
            left: left + codeW + gap,
            top,
            opacity: besideIn,
            transform: `translateY(${(1 - besideIn) * 10}px)`,
          }}
        >
          <div
            style={{
              fontFamily: mono,
              fontSize: 22,
              color: brand.fgMuted,
              position: "absolute",
              top: labelTop - top,
            }}
          >
            {step.beside.file}
          </div>
          <div
            style={{
              fontFamily: mono,
              fontSize: 24,
              lineHeight: `${24 * LINE}px`,
              whiteSpace: "pre",
            }}
          >
            {step.beside.lines.map((line, i) => (
              <div key={i}>
                <Tokens tokens={line} />
                {line.length === 0 ? " " : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {step.reel ? (
        <div
          style={{
            position: "absolute",
            left: 110,
            right: 110,
            top: 985,
            display: "flex",
            flexWrap: "wrap",
            rowGap: 14,
            columnGap: step.reel.items.length > 8 ? 34 : 44,
            fontFamily: sans,
            fontSize: step.reel.items.length > 8 ? 26 : 30,
            fontWeight: 600,
          }}
        >
          {step.reel.items.map((item, i) => {
            const lit = (s: RollStep | undefined) => (s?.reel?.at === i ? 1 : 0);
            const was = same ? lit(same) : lit(step);
            const passing = spin ? Math.round(pos) : 0;
            const at = spin
              ? passing === 0
                ? (same?.reel?.at ?? -1)
                : spin.reelFrom + passing - 1
              : -1;
            const on = spin ? (at === i ? 1 : 0) : was + (lit(step) - was) * t;
            return (
              <div
                key={item}
                style={{
                  color: on > 0.5 ? brand.fg : brand.fgMuted,
                  opacity: 0.45 + 0.55 * on,
                  paddingBottom: 8,
                  borderBottom: `3px solid rgba(126, 231, 135, ${on})`,
                }}
              >
                {item}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
};
