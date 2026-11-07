import { AbsoluteFill, Img, interpolate, spring, staticFile, useVideoConfig } from "remotion";
import type { CodeStep, Mark, Token } from "../../shared/intro.ts";
import { hand, mono, sans } from "../fonts.ts";
import { brand, vscode } from "../theme.ts";
import { BundleView } from "./Bundle.tsx";
import {
  Arrow,
  boxPath,
  circlePath,
  drawProgress,
  stroke,
  strikePath,
  TONE,
  underlinePath,
} from "./draw.tsx";
import { DrillView } from "./Drill.tsx";
import { graphAnchor, MiniGraphView } from "./MiniGraph.tsx";
import { ReqView, reqHeight } from "./Req.tsx";
import { TimelineView } from "./Timeline.tsx";

/** The code canvas, inside the frame and above the caption band. */
/** Below the step title at the top of the frame. */
const AREA = { x: 110, y: 170, width: 1700, height: 870 };
export type Area = typeof AREA;
/** Two files side by side: each gets half the canvas. The left pane starts where full-width code does. */
export const SPLIT = {
  left: { ...AREA, width: 850 },
  right: { ...AREA, x: 990, width: 820 },
  /** The left pane's top half, when a generated file sits under it. */
  leftTop: { ...AREA, width: 850, height: 390 },
  /** Under the left pane: a file generated from it. */
  leftBottom: { ...AREA, y: 620, width: 850, height: 420 },
};
const PANEL_WIDTH = 560;
/** Width kept for the drawing when a step has one. */
export const DIAGRAM_WIDTH = 760;
/** Left edge of the drawing (MiniGraph's area). */
const DRAWING_X = 1090;
const CHAR = 0.6;
const LINE = 1.55;

const lineText = (tokens: Token[]) => tokens.map((t) => t.text).join("");

/** Pixel geometry for the code block, centred in whatever space it gets. */
const layout = (step: CodeStep, area: Area = AREA) => {
  const width =
    area.width -
    (step.diagram || step.timeline
      ? DIAGRAM_WIDTH + 60
      : step.panel || step.drill || step.req || step.bundle || (step.error && !step.error.below)
        ? PANEL_WIDTH + 60
        : 0);
  const size = step.fontSize;
  const cw = size * CHAR;
  const lh = size * LINE;
  const longest = Math.max(...step.lines.map((l) => lineText(l).length), 1);
  const blockW = longest * cw;
  const blockH = step.lines.length * lh;
  // Code sits at the same left edge on every step, so it never shifts sideways
  // when a panel comes or goes. Only a one-line hero snippet is centred.
  const left = step.lines.length > 1 ? area.x + 30 : area.x + Math.max(0, (width - blockW) / 2);
  // With a drawing the program grows over several steps: pin its first line
  // so new lines extend downward instead of pushing the code up.
  // Code always starts at the same spot under its label; only a one-line hero is centred.
  const top =
    step.diagram || step.lines.length > 1
      ? area.y + 90
      : area.y + 50 + Math.max(0, (area.height - 50 - blockH) / 2);
  return { size, cw, lh, left, top, blockW, blockH, width };
};

const rect = (
  step: CodeStep,
  g: ReturnType<typeof layout>,
  mark: { line: number; col: number; len: number },
) => ({
  x: g.left + mark.col * g.cw,
  y: g.top + mark.line * g.lh,
  w: mark.len * g.cw,
  h: g.lh,
});

/**
 * Lines of the previous code step in the same group, matched to this step's
 * lines so unchanged lines glide from where they were.
 */
const matchLines = (prev: CodeStep | undefined, step: CodeStep) => {
  const from = new Map<number, number>();
  if (!prev || prev.group !== step.group) return from;
  const used = new Set<number>();
  const prevText = prev.lines.map((l) => lineText(l).trim());
  step.lines.forEach((line, i) => {
    const text = lineText(line).trim();
    if (!text) return;
    let best = -1;
    for (let j = 0; j < prevText.length; j++) {
      if (used.has(j) || prevText[j] !== text) continue;
      if (best < 0 || Math.abs(j - i) < Math.abs(best - i)) best = j;
    }
    if (best >= 0) {
      used.add(best);
      from.set(i, best);
    }
  });
  return from;
};

/**
 * Changed lines that are a small edit of a previous line: the columns that
 * differ (in the new line), so only that span is highlighted and fades in.
 */
const modifiedLines = (prev: CodeStep, step: CodeStep, matched: Map<number, number>) => {
  const out = new Map<number, { from: number; start: number; end: number }>();
  const taken = new Set(matched.values());
  // Compare without indentation, so re-indenting a line isn't an edit.
  const prevText = prev.lines.map((l) => lineText(l).trimStart());
  const prevIndent = prev.lines.map((l) => lineText(l).length - lineText(l).trimStart().length);
  step.lines.forEach((line, i) => {
    const full = lineText(line);
    const indent = full.length - full.trimStart().length;
    const text = full.trimStart();
    if (matched.has(i) || !text) return;
    let best: { from: number; start: number; end: number; score: number } | undefined;
    prevText.forEach((old, j) => {
      if (taken.has(j) || !old.trim()) return;
      let pre = 0;
      while (pre < old.length && pre < text.length && old[pre] === text[pre]) pre++;
      let suf = 0;
      while (
        suf < old.length - pre &&
        suf < text.length - pre &&
        old[old.length - 1 - suf] === text[text.length - 1 - suf]
      )
        suf++;
      const score = pre + suf;
      // Mostly the same line, or the old line with something inserted into it.
      const insertion = score >= old.length && old.trim().length >= 2;
      // The old line with something taken out: nothing new to highlight.
      const deletion = score >= text.length && text.trim().length >= 2;
      // Re-indented lines only count when they just lost text (e.g. being wrapped).
      if (!deletion && prevIndent[j] !== indent) return;
      if (!insertion && !deletion && score < Math.max(old.length, text.length) * 0.4) return;
      if (!deletion && text.length - suf <= pre) return;
      if (
        !best ||
        score > best.score ||
        (score === best.score && Math.abs(j - i) < Math.abs(best.from - i))
      )
        best = { from: j, start: indent + pre, end: indent + text.length - suf, score };
    });
    if (best) {
      taken.add(best.from);
      out.set(i, { from: best.from, start: best.start, end: best.end });
    }
  });
  return out;
};

/** Tokens split at a column range, so part of a line can be styled on its own. */
const sliceTokens = (tokens: Token[], start: number, end: number) => {
  const out: { token: Token; inside: boolean }[] = [];
  let col = 0;
  for (const token of tokens) {
    const a = col;
    const b = col + token.text.length;
    const cuts = [a, Math.min(Math.max(start, a), b), Math.min(Math.max(end, a), b), b];
    for (let k = 0; k < 3; k++) {
      if (cuts[k + 1]! > cuts[k]!)
        out.push({
          token: { ...token, text: token.text.slice(cuts[k]! - a, cuts[k + 1]! - a) },
          inside: k === 1,
        });
    }
    col = b;
  }
  return out;
};

const MarkView = ({
  mark,
  g,
  step,
  progress,
  index,
}: {
  mark: Mark;
  g: ReturnType<typeof layout>;
  step: CodeStep;
  progress: number;
  index: number;
}) => {
  const r = rect(step, g, mark);
  const color = TONE[mark.tone ?? "construct"];
  const seed = index * 13 + mark.line * 7 + mark.col;
  let path: string;
  if (mark.kind === "circle") path = circlePath(r.x, r.y, r.w, r.h, seed);
  else if (mark.kind === "underline") path = underlinePath(r.x, r.y + r.h * 0.92, r.w, seed);
  else if (mark.kind === "strike") path = strikePath(r.x, r.y + r.h * 0.52, r.w, seed);
  else if (mark.kind === "box") {
    const lastLine = mark.toLine ?? mark.line;
    const w = mark.toLine
      ? Math.max(...step.lines.slice(mark.line, lastLine + 1).map((l) => lineText(l).length)) *
          g.cw -
        mark.col * g.cw
      : r.w;
    path = boxPath(r.x, r.y, w, (lastLine - mark.line + 1) * g.lh, seed);
  } else path = "";

  // An arrowed label sits well clear of the code, with the arrow bridging the gap.
  const reach = mark.arrow ? 110 : 0;
  const labelPos = (() => {
    switch (mark.side ?? "right") {
      case "below":
        return {
          x: r.x + r.w / 2,
          y: r.y + r.h + (mark.kind === "circle" ? 34 : 22) + reach,
          anchor: "middle" as const,
        };
      case "above":
        return {
          x: r.x + r.w / 2,
          y: r.y - (mark.kind === "circle" ? 30 : 16),
          anchor: "middle" as const,
        };
      case "left":
        return { x: r.x - 40, y: r.y + r.h / 2 + 10, anchor: "end" as const };
      default: {
        // Past the end of the line, so the label never sits on code.
        const lineEnd = g.left + lineText(step.lines[mark.line] ?? []).length * g.cw;
        const x = Math.max(r.x + r.w + (mark.kind === "circle" ? 44 : 28), lineEnd + 36);
        return { x, y: r.y + r.h / 2 + 10, anchor: "start" as const };
      }
    }
  })();
  const labelIn = interpolate(progress, [0.55, 1], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const labelSize = Math.min(52, Math.max(34, g.size * 1.05));
  const labelLines = (mark.label ?? "").split("\n");
  const arrowIn = interpolate(progress, [0.35, 0.8], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <g>
      {mark.kind === "highlight" ? (
        <rect
          x={r.x - 8}
          y={r.y + 4}
          width={(r.w + 16) * progress}
          height={r.h - 8}
          rx={6}
          fill={color}
          opacity={0.22}
        />
      ) : (
        stroke(path, color, progress, mark.kind === "strike" ? 5 : 4)
      )}
      {mark.label ? (
        <text
          x={labelPos.x}
          y={labelPos.y}
          textAnchor={labelPos.anchor}
          fill={color}
          fontFamily={hand}
          fontWeight={700}
          fontSize={labelSize}
          opacity={labelIn}
          stroke={brand.bg}
          strokeWidth={12}
          strokeLinejoin="round"
          paintOrder="stroke"
        >
          {labelLines.map((line, i) => (
            <tspan key={i} x={labelPos.x} dy={i === 0 ? 0 : labelSize * 1.05}>
              {line}
            </tspan>
          ))}
        </text>
      ) : null}
      {mark.arrow && mark.label && (mark.side === "below" || mark.side === "above") ? (
        <Arrow
          x1={labelPos.x - 30}
          y1={mark.side === "below" ? labelPos.y - labelSize * 0.9 : labelPos.y + labelSize * 0.4}
          x2={r.x + r.w / 2}
          y2={mark.side === "below" ? r.y + r.h + 10 : r.y - 10}
          color={color}
          progress={arrowIn}
          bend={0.18}
        />
      ) : null}
    </g>
  );
};

export const CodeSlide = ({
  step,
  prev,
  prev2,
  local,
  area = AREA,
}: {
  step: CodeStep;
  prev?: CodeStep;
  /** The step before `prev`: what was dimmed and drawn when this step began. */
  prev2?: CodeStep;
  local: number;
  /** Where the code sits: the whole canvas, or one side of a split. */
  area?: Area;
}) => {
  const { fps } = useVideoConfig();
  const g = layout(step, area);
  const morph = prev && prev.group === step.group;
  const matched = matchLines(morph ? prev : undefined, step);
  const pg = prev ? layout(prev, area) : g;
  const asideIn =
    prev?.aside?.text === step.aside?.text
      ? 1
      : interpolate(local, [4, 12], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
  // The photo lands after the text, with a little overshoot.
  const photoIn =
    prev?.aside?.image === step.aside?.image
      ? 1
      : spring({ frame: local - 12, fps, config: { damping: 11, stiffness: 160 } });
  const t = morph
    ? interpolate(local, [0, 8], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
        easing: (x) => 1 - (1 - x) ** 3,
      })
    : interpolate(local, [0, 6], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const newIn = morph
    ? interpolate(local, [2, 8], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
    : t;
  const marksStart = morph ? 6 : 4;

  // Lines new or changed since the previous step stay bright; the rest dims.
  // Each line moves from how bright it was at the end of the previous step.
  // Only an edit gets highlighted: when most of the code is new, it's a different snippet.
  const isEdit = (from: CodeStep, to: CodeStep, m: Map<number, number>) =>
    m.size >= from.lines.filter((l) => lineText(l).trim()).length / 2 && to.lines.length > 0;
  // A step with a diff shows its changes as -/+ lines; otherwise changed lines are worked out here.
  const edit = !step.diff && !!morph && isEdit(prev!, step, matched);
  const changed = (i: number) =>
    step.diff ? !!step.diff[i] : edit && !matched.has(i) && !!lineText(step.lines[i] ?? []).trim();
  const modified = edit
    ? modifiedLines(prev!, step, matched)
    : new Map<number, { from: number; start: number; end: number }>();
  const anyChanged =
    step.tints.length === 0 && !step.quiet && step.lines.some((_, i) => changed(i));
  const morph2 = !!prev && !!prev2 && prev.group === step.group && prev2.group === prev.group;
  const prevMatched = morph2 ? matchLines(prev2, prev!) : new Map<number, number>();
  const prevEdit = morph2 && isEdit(prev2!, prev!, prevMatched);
  const prevChanged = (j: number) =>
    prev?.diff
      ? !!prev.diff[j]
      : prevEdit && !prevMatched.has(j) && !!lineText(prev!.lines[j] ?? []).trim();
  const prevAny =
    (morph2 || !!prev?.diff) &&
    prev!.tints.length === 0 &&
    !prev!.quiet &&
    prev!.lines.some((_, j) => prevChanged(j));
  const dimT = interpolate(local, [0, 8], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  // Lines with a mark on them stay bright too: dimming what's circled fights the circle.
  const marked = (i: number) => step.marks.some((m) => i >= m.line && i <= (m.toLine ?? m.line));
  const lineLevel = (i: number) => {
    const target = anyChanged ? (changed(i) || marked(i) ? 1 : 0.4) : 1;
    const from = matched.get(i);
    const start = from === undefined ? target : prevAny ? (prevChanged(from) ? 1 : 0.4) : 1;
    return start + (target - start) * dimT;
  };
  // A mark already drawn in the previous step stays drawn instead of redrawing.
  const sameMark = (m: Mark) =>
    !!morph &&
    prev!.marks.some(
      (p) =>
        p.kind === m.kind &&
        lineText(prev!.lines[p.line] ?? []).slice(p.col, p.col + p.len) ===
          lineText(step.lines[m.line] ?? []).slice(m.col, m.col + m.len),
    );

  const tintOf = (i: number) => step.tints.find((tint) => i >= tint.from && i <= tint.to);
  const focused = (i: number) => !step.focus || (i >= step.focus.from && i <= step.focus.to);

  return (
    <AbsoluteFill>
      {step.file || step.pseudo ? (
        <div
          style={{
            position: "absolute",
            left: area.x,
            top: area.y,
            display: "flex",
            alignItems: "center",
            gap: 12,
            // What the code is: the imaginary language, or the file being shown.
            fontFamily: mono,
            fontSize: 22,
            color: brand.fgMuted,
            // Continuing the same code: the label is already there.
            opacity: morph ? 1 : t,
          }}
        >
          {step.pseudo ? "an imaginary cloud language" : step.file}
        </div>
      ) : null}
      {step.diagram ? (
        <div
          style={{
            position: "absolute",
            left: DRAWING_X,
            top: AREA.y,
            fontFamily: mono,
            fontSize: 22,
            color: brand.fgMuted,
            opacity: morph ? 1 : t,
          }}
        >
          the cloud
        </div>
      ) : null}
      {/* a diff: removed lines in red with -, added lines in green with + */}
      {step.diff
        ? step.diff.map((d, i) => {
            if (!d) return null;
            const add = d.kind === "add";
            // A step that says what it adds (resource, binding, API) tints its new lines in the pyramid's colour.
            const layer = add && step.layer ? LAYER[step.layer] : undefined;
            const color = layer ? layer.color : add ? "#2ea043" : "#f85149";
            const first = add && !step.diff![i - 1]?.kind;
            return (
              <div key={`diff-${i}`} style={{ opacity: add ? newIn : 1 }}>
                <div
                  style={{
                    position: "absolute",
                    left: g.left - 40,
                    top: g.top + i * g.lh,
                    width: g.blockW + 66,
                    height: g.lh,
                    background: layer
                      ? `${layer.color}24`
                      : add
                        ? "rgba(46, 160, 67, 0.16)"
                        : "rgba(248, 81, 73, 0.16)",
                  }}
                />
                {layer && first && step.diff!.findIndex((x) => x?.kind === "add") === i ? (
                  <div
                    style={{
                      position: "absolute",
                      left: g.left + g.blockW + 44,
                      top: g.top + i * g.lh,
                      height: g.lh,
                      lineHeight: `${g.lh}px`,
                      fontFamily: hand,
                      fontWeight: 700,
                      fontSize: Math.max(30, g.size * 1.3),
                      color: layer.color,
                      whiteSpace: "nowrap",
                    }}
                  >
                    ← {layer.label}
                  </div>
                ) : null}
                {d.start !== undefined && d.end !== undefined && d.end > d.start ? (
                  <div
                    style={{
                      position: "absolute",
                      left: g.left + d.start * g.cw - 3,
                      top: g.top + i * g.lh + 3,
                      width: (d.end - d.start) * g.cw + 6,
                      height: g.lh - 6,
                      borderRadius: 4,
                      background: layer
                        ? `${layer.color}66`
                        : add
                          ? "rgba(46, 160, 67, 0.4)"
                          : "rgba(248, 81, 73, 0.4)",
                    }}
                  />
                ) : null}
                <div
                  style={{
                    position: "absolute",
                    left: g.left - 32,
                    top: g.top + i * g.lh,
                    height: g.lh,
                    lineHeight: `${g.lh}px`,
                    fontFamily: mono,
                    fontSize: g.size,
                    fontWeight: 700,
                    color,
                  }}
                >
                  {add ? "+" : "-"}
                </div>
              </div>
            );
          })
        : null}
      {/* lines new or changed since the previous step in this sequence, in diff green */}
      {/* Steps that tint phases are about the phases, not the edit: no change highlight. */}
      {edit && step.tints.length === 0 && !step.quiet
        ? step.lines.map((tokens, i) => {
            if (matched.has(i) || !lineText(tokens).trim()) return null;
            const span = modified.get(i);
            if (span && span.end <= span.start) return null;
            if (span) {
              // An edit within the line: mark the line, highlight just the new part.
              return (
                <div key={`added-${i}`}>
                  <div
                    style={{
                      position: "absolute",
                      left: g.left - 26,
                      top: g.top + i * g.lh,
                      width: 4,
                      height: g.lh,
                      background: "#2ea043",
                      opacity: newIn,
                    }}
                  />
                  <div
                    style={{
                      position: "absolute",
                      left: g.left + span.start * g.cw - 4,
                      top: g.top + i * g.lh + 3,
                      width: (span.end - span.start) * g.cw + 8,
                      height: g.lh - 6,
                      borderRadius: 5,
                      background: "rgba(46, 160, 67, 0.3)",
                      opacity: newIn,
                    }}
                  />
                </div>
              );
            }
            return (
              <div
                key={`added-${i}`}
                style={{
                  position: "absolute",
                  left: g.left - 26,
                  top: g.top + i * g.lh,
                  width: g.blockW + 52,
                  height: g.lh,
                  background: "rgba(46, 160, 67, 0.22)",
                  borderLeft: "4px solid #2ea043",
                  opacity: newIn,
                }}
              />
            );
          })
        : null}
      {/* phase tints: a bar in the gutter and a faint wash behind the lines */}
      {step.lines.map((_, i) => {
        const tint = tintOf(i);
        if (!tint) return null;
        return (
          <div
            key={`tint-${i}`}
            style={{
              position: "absolute",
              left: g.left - 26,
              top: g.top + i * g.lh,
              width: g.blockW + 40,
              height: g.lh,
              background: `linear-gradient(90deg, ${TONE[tint.tone]}26, ${TONE[tint.tone]}08 70%, transparent)`,
              borderLeft: `4px solid ${TONE[tint.tone]}`,
              opacity: newIn,
            }}
          />
        );
      })}
      {step.lines.map((tokens, i) => {
        const span = modified.get(i);
        // An edited line glides from its old position; only the new part fades in.
        const from = matched.get(i) ?? span?.from;
        const y0 = from !== undefined ? pg.top + from * pg.lh : g.top + i * g.lh;
        const indentOf = (t: string) => t.length - t.trimStart().length;
        const shift =
          from !== undefined
            ? (indentOf(lineText(prev!.lines[from] ?? [])) - indentOf(lineText(tokens))) * g.cw
            : 0;
        const x0 = from !== undefined ? pg.left + shift : g.left;
        const y = y0 + (g.top + i * g.lh - y0) * t;
        const x = x0 + (g.left - x0) * t;
        const size =
          (from !== undefined ? pg.size : g.size) +
          (g.size - (from !== undefined ? pg.size : g.size)) * t;
        const opacity = (from !== undefined ? 1 : newIn) * (focused(i) ? 1 : 0.28) * lineLevel(i);
        const parts = span
          ? sliceTokens(tokens, span.start, span.end)
          : tokens.map((token) => ({ token, inside: false }));
        return (
          <div
            key={`line-${i}`}
            style={{
              position: "absolute",
              left: x,
              top: y,
              height: g.lh,
              lineHeight: `${g.lh}px`,
              fontFamily: mono,
              fontSize: size,
              whiteSpace: "pre",
              opacity,
            }}
          >
            {parts.map(({ token, inside }, k) => (
              <span
                key={k}
                style={{
                  color: token.color,
                  opacity: inside ? newIn : 1,
                  fontWeight: token.bold ? 700 : undefined,
                }}
              >
                {token.text}
              </span>
            ))}
          </div>
        );
      })}
      {step.error ? (
        <ErrorView
          step={step}
          g={g}
          local={local}
          delay={marksStart}
          minTop={step.req ? g.top + reqHeight(step.req) + 20 : AREA.y}
        />
      ) : null}
      {step.bundle ? (
        <BundleView
          bundle={step.bundle}
          prev={prev?.bundle}
          x={AREA.x + AREA.width - PANEL_WIDTH}
          labelY={AREA.y}
          top={g.top}
          local={local}
          delay={marksStart}
        />
      ) : null}
      {step.req ? (
        <ReqView
          req={step.req}
          prev={prev?.req}
          x={AREA.x + AREA.width - PANEL_WIDTH}
          labelY={AREA.y}
          top={g.top}
          local={local}
          delay={marksStart}
        />
      ) : null}
      <svg
        width={1920}
        height={1080}
        style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }}
      >
        {step.marks.map((mark, i) => (
          <MarkView
            key={i}
            mark={mark}
            g={g}
            step={step}
            index={i}
            progress={sameMark(mark) ? 1 : drawProgress(local, marksStart + i * 4, 9)}
          />
        ))}
      </svg>
      {step.timeline ? (
        <TimelineView timeline={step.timeline} local={local} delay={marksStart} />
      ) : null}
      {step.diagram ? (
        <MiniGraphView
          graph={step.diagram}
          prev={morph ? prev?.diagram : undefined}
          prev2={morph && prev2?.group === step.group ? prev2.diagram : undefined}
          local={local}
          delay={marksStart}
        />
      ) : null}
      {step.diagram && step.diagramLinks ? (
        <svg
          width={1920}
          height={1080}
          style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }}
        >
          {step.diagramLinks.map((link, i) => {
            const to = graphAnchor(step.diagram!, link.to);
            if (!to) return null;
            const color = TONE[link.tone ?? "construct"];
            const r = rect(step, g, link.from);
            // The underline runs on along the baseline to just past the code, bends
            // to the target's height there, then runs straight in: turning early
            // keeps the arc clear of nodes and notes between the code and its target.
            const y1 = r.y + r.h * 0.92;
            const gx = g.left + Math.max(...step.lines.map((l) => lineText(l).length)) * g.cw + 14;
            // A link that was already drawn on the previous step stays drawn.
            const text = (st: CodeStep, sp: { line: number; col: number; len: number }) =>
              lineText(st.lines[sp.line] ?? []).slice(sp.col, sp.col + sp.len);
            const drawn = prev?.diagramLinks?.some(
              (p) =>
                JSON.stringify(p.to) === JSON.stringify(link.to) &&
                text(prev, p.from) === text(step, link.from),
            );
            const start = drawn ? -100 : marksStart + i * 6;
            return (
              <g key={i}>
                {stroke(
                  underlinePath(r.x, y1, r.w, i * 5 + 2),
                  color,
                  drawProgress(local, start, 6),
                  3,
                )}
                <g opacity={0.75}>
                  {stroke(
                    `M ${r.x + r.w} ${y1} L ${gx} ${y1} C ${gx + 55} ${y1}, ${gx + 30} ${to.y}, ${gx + 85} ${to.y} L ${to.x} ${to.y}`,
                    color,
                    drawProgress(local, start + 3, 9),
                    2.5,
                  )}
                </g>
              </g>
            );
          })}
        </svg>
      ) : null}
      {step.cross ? (
        <svg
          width={1920}
          height={1080}
          style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }}
        >
          {(() => {
            // Two quick hand-drawn strokes over the code block, already drawn if the previous step had them.
            const x0 = g.left - 20;
            const y0 = g.top - 16;
            const x1 = g.left + g.blockW + 20;
            const y1 = g.top + g.blockH + 16;
            const at = prev?.cross ? -100 : 4;
            return (
              <>
                {stroke(
                  `M ${x0} ${y0} Q ${(x0 + x1) / 2 + 18} ${(y0 + y1) / 2 - 14}, ${x1} ${y1}`,
                  TONE.bad,
                  drawProgress(local, at, 7),
                  12,
                )}
                {stroke(
                  `M ${x1 + 6} ${y0 + 8} Q ${(x0 + x1) / 2 - 12} ${(y0 + y1) / 2 - 10}, ${x0 - 4} ${y1 - 6}`,
                  TONE.bad,
                  drawProgress(local, at + 6, 7),
                  12,
                )}
              </>
            );
          })()}
        </svg>
      ) : null}
      {step.aside?.at === "left" ? (
        <div
          style={{
            position: "absolute",
            left: AREA.x + 20,
            bottom: 1080 - (AREA.y + AREA.height) + 6,
            display: "flex",
            alignItems: "center",
            gap: 34,
          }}
        >
          {step.aside.image ? (
            <div
              style={{
                width: 400,
                padding: 12,
                background: "#f4efe4",
                borderRadius: 6,
                boxShadow: "0 18px 50px rgba(0, 0, 0, 0.55)",
                transform: `rotate(${-3 + (1 - photoIn) * 10}deg) scale(${photoIn})`,
                transformOrigin: "center bottom",
                opacity: Math.min(1, photoIn * 2),
              }}
            >
              <Img
                src={staticFile(`intro/assets/${step.aside.image}`)}
                style={{ width: "100%", display: "block", borderRadius: 3 }}
              />
            </div>
          ) : null}
          <div
            style={{
              fontFamily: hand,
              fontWeight: 700,
              fontSize: 54,
              lineHeight: 1.05,
              color: TONE[step.aside.tone ?? "construct"],
              transform: `rotate(-4deg) scale(${0.85 + asideIn * 0.15})`,
              opacity: asideIn,
              whiteSpace: "pre",
            }}
          >
            {step.aside.text}
          </div>
        </div>
      ) : null}
      {step.aside?.image && step.aside.at !== "left" ? (
        <div
          style={{
            position: "absolute",
            right: 1920 - (AREA.x + AREA.width) + 40,
            bottom: 1080 - (AREA.y + AREA.height) + 170,
            width: 330,
            padding: 12,
            paddingBottom: 12,
            background: "#f4efe4",
            borderRadius: 6,
            boxShadow: "0 18px 50px rgba(0, 0, 0, 0.55)",
            transform: `rotate(${4 - (1 - photoIn) * 10}deg) scale(${photoIn})`,
            transformOrigin: "center bottom",
            opacity: Math.min(1, photoIn * 2),
          }}
        >
          <Img
            src={staticFile(`intro/assets/${step.aside.image}`)}
            style={{ width: "100%", display: "block", borderRadius: 3 }}
          />
        </div>
      ) : null}
      {step.aside && step.aside.at !== "left" ? (
        <div
          style={{
            position: "absolute",
            right: 1920 - (AREA.x + AREA.width) + 10,
            bottom: 1080 - (AREA.y + AREA.height) + 40,
            fontFamily: hand,
            fontWeight: 700,
            fontSize: 84,
            lineHeight: 1,
            whiteSpace: "nowrap",
            color: TONE[step.aside.tone ?? "construct"],
            textShadow: "0 0 24px rgba(0, 0, 0, 0.6)",
            transform: `rotate(-5deg) scale(${0.85 + asideIn * 0.15})`,
            transformOrigin: "right bottom",
            opacity: asideIn,
          }}
        >
          {step.aside.text}
          <svg
            width="100%"
            height={24}
            viewBox="0 0 600 24"
            preserveAspectRatio="none"
            style={{ display: "block", overflow: "visible" }}
          >
            {stroke(
              underlinePath(0, 10, 600, 11),
              TONE[step.aside.tone ?? "construct"],
              drawProgress(local, 10, 8),
              5,
            )}
          </svg>
        </div>
      ) : null}
      {step.drill ? (
        <DrillView
          drill={step.drill}
          x={AREA.x + AREA.width - PANEL_WIDTH}
          labelY={AREA.y}
          top={g.top}
          local={local}
          delay={marksStart + step.marks.filter((m) => !sameMark(m)).length * 4}
        />
      ) : null}
      {step.panel ? (
        <Panel step={step} local={local} delay={marksStart + step.marks.length * 4} fps={fps} />
      ) : null}
      {step.reel ? <Reel reel={step.reel} prev={prev?.reel} local={local} /> : null}
    </AbsoluteFill>
  );
};

const ErrorView = ({
  step,
  g,
  local,
  delay,
  minTop,
}: {
  step: CodeStep;
  g: ReturnType<typeof layout>;
  local: number;
  delay: number;
  minTop: number;
}) => {
  const error = step.error!;
  const r = rect(step, g, error);
  const p = drawProgress(local, delay, 8);
  const box = interpolate(local, [delay + 4, delay + 10], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  // A squiggle along the error range.
  const wave: string[] = [];
  for (let x = 0; x <= r.w * p; x += 6)
    wave.push(`${r.x + x},${r.y + r.h - 4 + (Math.floor(x / 6) % 2 ? 4 : 0)}`);
  // Under the code, like an editor tooltip; or in the right column beside it.
  // Under the code, bottom-right and sized to the message; or in the right column beside it.
  const boxWidth = error.below
    ? Math.min(900, 60 + Math.max(...error.message.map((l) => l.length)) * 12.6)
    : PANEL_WIDTH;
  const boxX = error.below ? AREA.x + AREA.width - boxWidth : AREA.x + AREA.width - PANEL_WIDTH;
  const boxY = error.below
    ? Math.min(g.top + step.lines.length * g.lh + 28, AREA.y + AREA.height - 100)
    : Math.min(Math.max(minTop, r.y - 40), AREA.y + AREA.height - 320);
  return (
    <>
      <svg width={1920} height={1080} style={{ position: "absolute", left: 0, top: 0 }}>
        {wave.length > 1 ? (
          <polyline points={wave.join(" ")} fill="none" stroke="#f14c4c" strokeWidth={2.5} />
        ) : null}
        {box > 0 && !error.below ? (
          <path
            d={`M ${r.x + r.w * 0.5} ${r.y + r.h + 2} C ${r.x + r.w * 0.5} ${r.y + r.h + 60}, ${boxX - 80} ${boxY + 30}, ${boxX - 8} ${boxY + 30}`}
            fill="none"
            stroke="#f14c4c"
            strokeWidth={2}
            strokeDasharray="6 6"
            opacity={box}
          />
        ) : null}
      </svg>
      <div
        style={{
          position: "absolute",
          left: boxX,
          top: boxY,
          width: boxWidth,
          padding: "14px 18px",
          background: "#252526",
          border: "1px solid #454545",
          borderRadius: 6,
          boxShadow: "0 12px 32px rgba(0,0,0,0.5)",
          fontFamily: mono,
          fontSize: 21,
          lineHeight: 1.5,
          color: "#cccccc",
          whiteSpace: "pre-wrap",
          opacity: box,
          transform: `translateY(${(1 - box) * 8}px)`,
        }}
      >
        {error.message.map((line, i) => (
          <div
            key={i}
            style={{
              paddingLeft: i * 18,
              color: i === error.message.length - 1 ? "#ffffff" : "#cccccc",
            }}
          >
            {line}
          </div>
        ))}
        <div style={{ marginTop: 6, color: "#9d9d9d", fontFamily: sans, fontSize: 15 }}>
          {error.code}
        </div>
      </div>
    </>
  );
};

const Panel = ({
  step,
  local,
  delay,
}: {
  step: CodeStep;
  local: number;
  delay: number;
  fps: number;
}) => {
  const panel = step.panel!;
  const x = AREA.x + AREA.width - PANEL_WIDTH;
  const inAt = (i: number) =>
    interpolate(local, [delay + i * 3, delay + i * 3 + 7], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: AREA.y,
        width: PANEL_WIDTH,
        height: AREA.height,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 22,
        fontFamily: sans,
      }}
    >
      <div
        style={{
          fontFamily: hand,
          fontWeight: 700,
          fontSize: 40,
          color: TONE.construct,
          opacity: inAt(0),
        }}
      >
        {panel.title}
      </div>
      {panel.items.map((item, i) => {
        const color = TONE[item.tone ?? "neutral"];
        const p = inAt(i + 1);
        return (
          <div key={i} style={{ opacity: p, transform: `translateX(${(1 - p) * 20}px)` }}>
            <div style={{ color: item.tone ? color : brand.fg, fontSize: 24, fontWeight: 600 }}>
              {item.title}
            </div>
            {item.body ? (
              <div style={{ color: brand.fgMuted, fontSize: 20, marginTop: 4 }}>{item.body}</div>
            ) : null}
            {item.mono ? (
              <pre
                style={{
                  margin: "10px 0 0",
                  padding: "14px 16px",
                  background: vscode.editorBg,
                  border: `1px solid ${item.tone ? color : "rgba(255,255,255,0.1)"}`,
                  borderRadius: 10,
                  fontFamily: mono,
                  fontSize: 18,
                  lineHeight: 1.45,
                  color: "#d4d4d4",
                  whiteSpace: "pre-wrap",
                }}
              >
                {item.mono}
              </pre>
            ) : null}
            {item.bar !== undefined ? (
              <div
                style={{
                  marginTop: 10,
                  height: 18,
                  borderRadius: 9,
                  background: "rgba(255,255,255,0.06)",
                }}
              >
                <div
                  style={{
                    width: `${item.bar * 100 * p}%`,
                    minWidth: 10,
                    height: "100%",
                    borderRadius: 9,
                    background: color,
                  }}
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
};

/** Where a span of text sits on screen, for drawing between panes. */
export const spanRect = (
  step: CodeStep,
  area: Area,
  span: { line: number; col: number; len: number },
) => rect(step, layout(step, area), span);

/** The pyramid's colours, for the kind of thing a step adds. */
const LAYER = {
  resource: { color: "#8b9cf6", label: "resource" },
  binding: { color: "#e0a86b", label: "binding" },
  api: { color: "#a3c473", label: "API" },
} as const;

/** The option row under the code, at the same place as on roll slides. */
const Reel = ({
  reel,
  prev,
  local,
}: {
  reel: NonNullable<CodeStep["reel"]>;
  prev?: CodeStep["reel"];
  local: number;
}) => {
  const t = interpolate(local, [0, 12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        position: "absolute",
        left: 110,
        right: 110,
        top: 985,
        display: "flex",
        flexWrap: "wrap",
        rowGap: 14,
        columnGap: 44,
        fontFamily: sans,
        fontSize: 30,
        fontWeight: 600,
      }}
    >
      {reel.items.map((item, i) => {
        const was = prev ? (prev.at === i ? 1 : 0) : reel.at === i ? 1 : 0;
        const on = was + ((reel.at === i ? 1 : 0) - was) * t;
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
  );
};
