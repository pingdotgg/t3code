import type * as React from "react";
import { useEffect, useRef } from "react";
import { cn } from "~/lib/utils";

const PIXEL_GRID_CELL_IDS = ["tl", "tm", "tr", "ml", "mm", "mr", "bl", "bm", "br"] as const;
const PIXEL_GRID_NAMED_COLORS = [
  "cyan",
  "magenta",
  "yellow",
  "green",
  "orange",
  "blue",
  "red",
  "purple",
  "white",
  "teal",
  "pink",
  "lime",
] as const;

const PIXEL_GRID_PRESETS = {
  "wave-lr": {
    delays: [0, 120, 240, 0, 120, 240, 0, 120, 240],
    duration: 200,
  },
  "wave-rl": {
    delays: [240, 120, 0, 240, 120, 0, 240, 120, 0],
    duration: 200,
  },
  "wave-tb": {
    delays: [0, 0, 0, 120, 120, 120, 240, 240, 240],
    duration: 200,
  },
  "wave-bt": {
    delays: [240, 240, 240, 120, 120, 120, 0, 0, 0],
    duration: 200,
  },
  "spiral-cw": {
    delays: [0, 80, 160, 560, 640, 240, 480, 400, 320],
    duration: 180,
  },
  "corners-first": {
    delays: [0, 200, 0, 200, 400, 200, 0, 200, 0],
    duration: 200,
  },
  "center-out": {
    delays: [240, 120, 240, 120, 0, 120, 240, 120, 240],
    duration: 200,
  },
  "diagonal-tl": {
    delays: [0, 100, 200, 100, 200, 300, 200, 300, 400],
    duration: 180,
  },
  snake: {
    delays: [0, 80, 160, 400, 320, 240, 480, 560, 640],
    duration: 160,
  },
  cross: {
    delays: [300, 0, 300, 0, 0, 0, 300, 0, 300],
    duration: 250,
  },
  checkerboard: {
    delays: [0, 250, 0, 250, 0, 250, 0, 250, 0],
    duration: 220,
  },
  rain: {
    delays: [0, 180, 60, 120, 300, 240, 360, 80, 420],
    duration: 170,
  },
  pinwheel: {
    delays: [0, 160, 480, 320, 640, 160, 480, 320, 0],
    duration: 150,
  },
  orbit: {
    delays: [0, 80, 160, 480, 640, 240, 400, 320, 560],
    duration: 120,
  },
  converge: {
    delays: [0, 160, 80, 240, 320, 240, 80, 160, 0],
    duration: 260,
  },
  zigzag: {
    delays: [0, 160, 320, 400, 240, 80, 480, 560, 640],
    duration: 140,
  },
  aurora: {
    delays: [0, 100, 200, 100, 200, 300, 200, 300, 400],
    duration: 220,
    colors: ["cyan", "cyan", "teal", "teal", "blue", "blue", "purple", "purple", "magenta"],
  },
  ember: {
    delays: [0, 80, 160, 560, 640, 240, 480, 400, 320],
    duration: 180,
    colors: ["yellow", "orange", "orange", "orange", "red", "red", "red", "magenta", "magenta"],
  },
  prism: {
    delays: [0, 80, 160, 240, 320, 400, 480, 560, 640],
    duration: 160,
    colors: ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "magenta", "pink"],
  },
  "neon-cross": {
    delays: [300, 0, 300, 0, 0, 0, 300, 0, 300],
    duration: 250,
    colors: ["magenta", "cyan", "magenta", "cyan", "white", "cyan", "magenta", "cyan", "magenta"],
  },
  tide: {
    delays: [0, 0, 0, 120, 120, 120, 240, 240, 240],
    duration: 200,
    colors: ["teal", "cyan", "teal", "blue", "teal", "blue", "purple", "blue", "purple"],
  },
  sunset: {
    delays: [240, 240, 240, 120, 120, 120, 0, 0, 0],
    duration: 200,
    colors: ["purple", "blue", "purple", "magenta", "red", "magenta", "orange", "yellow", "orange"],
  },
  toxic: {
    delays: [0, 200, 0, 200, 400, 200, 0, 200, 0],
    duration: 200,
    colors: ["lime", "green", "lime", "green", "yellow", "green", "lime", "green", "lime"],
  },
  frost: {
    delays: [240, 120, 240, 120, 0, 120, 240, 120, 240],
    duration: 200,
    colors: ["blue", "cyan", "blue", "cyan", "white", "cyan", "blue", "cyan", "blue"],
  },
} as const;

const PIXEL_GRID_VARIANT_DEFAULT_PRESET = {
  sidebar: "spiral-cw",
  chat: "spiral-cw",
} as const;

type PixelGridPresetConfig = (typeof PIXEL_GRID_PRESETS)[keyof typeof PIXEL_GRID_PRESETS];
type PixelGridNamedColor = (typeof PIXEL_GRID_NAMED_COLORS)[number];
type PixelGridColor = string;

export type PixelGridLoaderVariant = "sidebar" | "chat";
export type PixelGridLoaderPreset = keyof typeof PIXEL_GRID_PRESETS;

export interface PixelGridLoaderProps extends React.ComponentProps<"span"> {
  variant: PixelGridLoaderVariant;
  preset?: PixelGridLoaderPreset;
  color?: PixelGridColor;
  colors?: readonly string[];
}

function isNamedColor(value: string): value is PixelGridNamedColor {
  return PIXEL_GRID_NAMED_COLORS.includes(value as PixelGridNamedColor);
}

function colorVars(color: PixelGridColor): React.CSSProperties {
  return {
    "--pixel-on": color,
    "--pixel-off": `color-mix(in oklch, ${color} 25%, black)`,
    "--pixel-glow": `color-mix(in oklch, ${color} 60%, transparent)`,
  } as React.CSSProperties;
}

function resolvePreset(preset: PixelGridLoaderPreset | undefined, variant: PixelGridLoaderVariant) {
  const presetName = preset ?? PIXEL_GRID_VARIANT_DEFAULT_PRESET[variant];
  return {
    name: presetName,
    config: PIXEL_GRID_PRESETS[presetName],
  };
}

function maxDelay(config: PixelGridPresetConfig) {
  return Math.max(...config.delays);
}

export function PixelGridLoader({
  variant,
  preset,
  color = "currentColor",
  colors,
  className,
  style,
  "aria-hidden": ariaHidden = true,
  ...props
}: PixelGridLoaderProps) {
  const cellRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const { name: presetName, config } = resolvePreset(preset, variant);
  const resolvedCellColors = colors ?? ("colors" in config ? config.colors : undefined);

  useEffect(() => {
    const cells = cellRefs.current.slice(0, PIXEL_GRID_CELL_IDS.length);
    if (cells.some((cell) => cell === null)) {
      return;
    }

    const resolvedCells = cells as HTMLSpanElement[];
    const reducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let timers: Array<ReturnType<typeof setTimeout>> = [];
    let cycleTimer: ReturnType<typeof setTimeout> | null = null;
    let running = true;

    const clearTimers = () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers = [];
      if (cycleTimer !== null) {
        clearTimeout(cycleTimer);
        cycleTimer = null;
      }
    };

    const fadeIn = (onComplete: () => void) => {
      config.delays.forEach((delay, index) => {
        const cell = resolvedCells[index];
        if (!cell) return;
        timers.push(
          setTimeout(() => {
            cell.classList.add("is-on");
          }, delay),
        );
      });
      cycleTimer = setTimeout(onComplete, maxDelay(config) + config.duration);
    };

    const fadeOut = (onComplete: () => void) => {
      config.delays.forEach((delay, index) => {
        const cell = resolvedCells[index];
        if (!cell) return;
        timers.push(
          setTimeout(() => {
            cell.classList.remove("is-on");
          }, delay),
        );
      });
      cycleTimer = setTimeout(onComplete, maxDelay(config) + config.duration + 50);
    };

    const cycle = () => {
      if (!running) return;
      fadeIn(() => {
        if (!running) return;
        fadeOut(() => {
          if (!running) return;
          cycle();
        });
      });
    };

    resolvedCells.forEach((cell) => {
      cell.classList.remove("is-on");
    });

    if (reducedMotion) {
      resolvedCells.forEach((cell) => {
        cell.classList.add("is-on");
      });
      return () => {
        resolvedCells.forEach((cell) => {
          cell.classList.remove("is-on");
        });
      };
    }

    cycle();

    return () => {
      running = false;
      clearTimers();
      resolvedCells.forEach((cell) => {
        cell.classList.remove("is-on");
      });
    };
  }, [config, presetName]);

  const containerClassName = color && isNamedColor(color) ? `pixel-grid--${color}` : undefined;
  const containerStyle = {
    ...(variant === "sidebar"
      ? ({
          "--pixel-grid-cell-size": "2px",
        } as React.CSSProperties)
      : {}),
    ...(color && !isNamedColor(color) ? colorVars(color) : {}),
    ...style,
  } as React.CSSProperties;

  return (
    <span
      aria-hidden={ariaHidden}
      className={cn("pixel-grid pixel-grid-loader", containerClassName, className)}
      data-pixel-grid-preset={presetName}
      data-slot="pixel-grid-loader"
      style={containerStyle}
      {...props}
    >
      {PIXEL_GRID_CELL_IDS.map((cellId, index) => {
        const cellColor = resolvedCellColors?.[index];
        const cellClassName =
          cellColor && isNamedColor(cellColor) ? `pixel-grid__cell--${cellColor}` : undefined;

        return (
          <span
            key={`${presetName}-${cellId}`}
            ref={(node) => {
              cellRefs.current[index] = node;
            }}
            className={cn("pixel-grid__cell pixel-grid-loader__cell", cellClassName)}
            data-slot="pixel-grid-loader-cell"
            style={cellColor && !isNamedColor(cellColor) ? colorVars(cellColor) : undefined}
          />
        );
      })}
    </span>
  );
}
