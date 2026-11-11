import type { CodeStep } from "../../shared/intro.ts";
import { type Area, spanRect } from "./CodeSlide.tsx";
import { drawProgress, stroke, TONE, underlinePath } from "./draw.tsx";

/**
 * How two side-by-side files are coupled: each link underlines a piece of
 * text on the left, the piece it must agree with on the right, and draws a
 * line between them. Links draw one after another.
 */
export const LinksView = ({
  step,
  prev,
  left,
  right,
  local,
  delay,
}: {
  step: CodeStep;
  prev?: CodeStep;
  left: Area;
  right: Area;
  local: number;
  delay: number;
}) => {
  if (!step.links || !step.beside) return null;
  const text = (s: CodeStep, span: { line: number; col: number; len: number }) =>
    (s.lines[span.line] ?? [])
      .map((t) => t.text)
      .join("")
      .slice(span.col, span.col + span.len);
  // A link already drawn on the previous step (same text at both ends, same tone) stays drawn.
  const drawn = (link: NonNullable<CodeStep["links"]>[number]) =>
    !!prev?.links &&
    !!prev.beside &&
    prev.links.some(
      (p) =>
        (p.tone ?? "construct") === (link.tone ?? "construct") &&
        text(prev, p.from) === text(step, link.from) &&
        text(prev.beside!, p.to) === text(step.beside!, link.to),
    );
  let order = 0;
  return (
    <svg
      width={1920}
      height={1080}
      style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }}
    >
      {step.links.map((link, i) => {
        const color = TONE[link.tone ?? "construct"];
        const a = spanRect(step, left, link.from);
        const b = spanRect(step.beside!, right, link.to);
        const start = drawn(link) ? -100 : delay + order++ * 8;
        const ay = a.y + a.h * 0.92;
        const by = b.y + b.h * 0.92;
        const x1 = a.x + a.w;
        const x2 = b.x;
        const bend = Math.max(60, (x2 - x1) * 0.45);
        return (
          <g key={i}>
            {stroke(
              underlinePath(a.x, ay, a.w, i * 7 + 1),
              color,
              drawProgress(local, start, 6),
              3,
            )}
            <g opacity={0.7}>
              {stroke(
                `M ${x1} ${ay} C ${x1 + bend} ${ay}, ${x2 - bend} ${by}, ${x2} ${by}`,
                color,
                drawProgress(local, start + 4, 7),
                2,
              )}
            </g>
            {stroke(
              underlinePath(b.x, by, b.w, i * 7 + 4),
              color,
              drawProgress(local, start + 9, 6),
              3,
            )}
          </g>
        );
      })}
    </svg>
  );
};
