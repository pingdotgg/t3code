import { useLayoutEffect, useRef } from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

/** Resolves any CSS color (variables, color-mix) to a string a canvas accepts. */
export type ResolveColor = (cssColor: string) => string;

export type DitherDraw = (
  context: CanvasRenderingContext2D,
  size: { readonly width: number; readonly height: number },
  resolveColor: ResolveColor,
) => void;

function paintCanvas(canvas: HTMLCanvasElement, draw: DitherDraw) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width === 0 || height === 0) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const probe = document.createElement("span");
  probe.style.display = "none";
  canvas.after(probe);
  const resolved = new Map<string, string>();
  try {
    draw(context, { width, height }, (cssColor) => {
      let value = resolved.get(cssColor);
      if (value === undefined) {
        probe.style.color = cssColor;
        value = getComputedStyle(probe).color;
        resolved.set(cssColor, value);
      }
      return value;
    });
  } finally {
    probe.remove();
  }
}

/**
 * A canvas that redraws on every render, on resize, and on theme changes, so theme variables
 * feed the dither. Give it a fixed height through `className`.
 */
export function DitherCanvas({
  draw,
  className,
  label,
}: {
  readonly draw: DitherDraw;
  readonly className?: string;
  readonly label?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawRef = useRef(draw);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- repaints the canvas from the latest draw before the browser shows the frame
  useLayoutEffect(() => {
    drawRef.current = draw;
    if (canvasRef.current) paintCanvas(canvasRef.current, draw);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- repaints when the canvas resizes or the theme swaps its variables
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const repaint = () => paintCanvas(canvas, drawRef.current);
    const stopResize = observeResize(canvas, repaint);
    const themeObserver = new MutationObserver(repaint);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });
    return () => {
      stopResize();
      themeObserver.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("block w-full", className)}
    />
  );
}
