import "katex/dist/katex.min.css";
import katex from "katex";

import { parseExpression } from "../expression.ts";
import { card, cssVar, failure, h, onThemeChange, start, t } from "../runtime.ts";

interface MathData {
  readonly title: string;
  readonly formulas?: ReadonlyArray<string>;
  readonly functions?: ReadonlyArray<{ readonly expression: string; readonly label?: string }>;
  readonly xMin?: number;
  readonly xMax?: number;
  readonly yMin?: number;
  readonly yMax?: number;
}

const COLORS = ["", "#d97706", "#0d9488", "#9333ea", "#e11d48", "#65a30d", "#0284c7", "#78716c"];
const SAMPLES = 600;
const HEIGHT = 320;

const niceStep = (span: number) => {
  const raw = span / 8;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const scaled = raw / magnitude;
  return (scaled < 1.5 ? 1 : scaled < 3.5 ? 2 : scaled < 7.5 ? 5 : 10) * magnitude;
};

const svg = (tag: string, attributes: Readonly<Record<string, string | number>>) => {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  return element;
};

const plot = (data: MathData, width: number) => {
  const xMin = data.xMin ?? -10;
  const xMax = data.xMax ?? 10;
  const curves = (data.functions ?? []).map(({ expression }) => {
    const evaluate = parseExpression(expression);
    return Array.from({ length: SAMPLES + 1 }, (_, at) => {
      const x = xMin + ((xMax - xMin) * at) / SAMPLES;
      return [x, evaluate(x)] as const;
    });
  });
  const values = curves
    .flat()
    .map(([, y]) => y)
    .filter(Number.isFinite)
    .toSorted((a, b) => a - b);
  // Poles would flatten everything else, so the range ignores the outermost values.
  const low = values[Math.floor(values.length * 0.02)] ?? -1;
  const high = values[Math.ceil(values.length * 0.98) - 1] ?? 1;
  const pad = Math.max((high - low) * 0.1, 0.5);
  const yMin = data.yMin ?? low - pad;
  const yMax = data.yMax ?? high + pad;

  const toX = (x: number) => ((x - xMin) / (xMax - xMin)) * width;
  const toY = (y: number) => HEIGHT - ((y - yMin) / (yMax - yMin)) * HEIGHT;
  const root = svg("svg", { width: "100%", height: HEIGHT, viewBox: `0 0 ${width} ${HEIGHT}` });
  const line = cssVar("--line") || "#e6e3dc";
  const soft = cssVar("--soft") || "#66635c";
  const grid = (from: number, to: number, draw: (value: number) => void) => {
    const step = niceStep(to - from);
    for (let value = Math.ceil(from / step) * step; value <= to; value += step) {
      draw(Number(value.toPrecision(12)));
    }
  };
  const label = (text: string, x: number, y: number) => {
    const element = svg("text", { x, y, fill: soft, "font-size": 11 });
    element.textContent = text;
    root.append(element);
  };
  grid(xMin, xMax, (x) => {
    root.append(
      svg("line", {
        x1: toX(x),
        x2: toX(x),
        y1: 0,
        y2: HEIGHT,
        stroke: x === 0 ? soft : line,
      }),
    );
    if (x !== 0) label(String(x), toX(x) + 3, HEIGHT - 4);
  });
  grid(yMin, yMax, (y) => {
    root.append(
      svg("line", { x1: 0, x2: width, y1: toY(y), y2: toY(y), stroke: y === 0 ? soft : line }),
    );
    label(String(y), 3, toY(y) - 3);
  });
  curves.forEach((curve, at) => {
    let path = "";
    let previous: number | undefined;
    for (const [x, y] of curve) {
      const jump =
        previous !== undefined && Math.abs(y - previous) > (yMax - yMin) * 2 && y * previous < 0;
      if (!Number.isFinite(y)) {
        previous = undefined;
        continue;
      }
      path += `${previous === undefined || jump ? "M" : "L"}${toX(x).toFixed(2)} ${toY(y).toFixed(2)}`;
      previous = y;
    }
    root.append(
      svg("path", {
        d: path,
        fill: "none",
        stroke: COLORS[at] || cssVar("--accent") || "#3552d1",
        "stroke-width": 2.5,
      }),
    );
  });
  return root;
};

void start<MathData>((data, root) => {
  const formulas = (data.formulas ?? []).map((formula) => {
    const element = h("div", { class: "formula" });
    katex.render(formula, element, { displayMode: true, throwOnError: false });
    return element;
  });
  const canvas = h("div", { style: "overflow:hidden" });
  const legend = h(
    "div",
    { class: "row soft" },
    ...(data.functions ?? []).map(({ expression, label }, at) =>
      h(
        "span",
        {},
        h("i", {
          style: `display:inline-block;width:10px;height:10px;border-radius:3px;margin-inline-end:6px;background:${COLORS[at] || "var(--accent)"}`,
        }),
        label ?? `y = ${expression}`,
      ),
    ),
  );
  root.append(
    card(data.title, [...formulas, canvas, legend], {
      ask: `${t("About", "O")} "${data.title}": `,
    }),
  );
  if (data.functions === undefined || data.functions.length === 0) return;
  const draw = () => {
    try {
      canvas.replaceChildren(plot(data, Math.max(280, canvas.clientWidth)));
    } catch (error) {
      canvas.replaceChildren(failure(error));
    }
  };
  draw();
  onThemeChange(draw);
  new ResizeObserver(draw).observe(canvas.parentElement!);
});
