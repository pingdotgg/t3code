"use client";

import { PipetteIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";

import { ColorSelector } from "../color-selector";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { normalizeProviderAccentColor } from "../../providerInstances";
import { cn } from "../../lib/utils";

const PROVIDER_ACCENT_SWATCHES = [
  "#2563eb",
  "#16a34a",
  "#ea580c",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
] as const;

const FALLBACK_ACCENT_COLOR = PROVIDER_ACCENT_SWATCHES[0];

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function hexToHsv(hex: string) {
  const normalized = normalizeProviderAccentColor(hex) ?? FALLBACK_ACCENT_COLOR;
  const numeric = Number.parseInt(normalized.slice(1), 16);
  const red = ((numeric >> 16) & 255) / 255;
  const green = ((numeric >> 8) & 255) / 255;
  const blue = (numeric & 255) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;

  let hue = 0;
  if (delta !== 0) {
    if (max === red) {
      hue = ((green - blue) / delta) % 6;
    } else if (max === green) {
      hue = (blue - red) / delta + 2;
    } else {
      hue = (red - green) / delta + 4;
    }
    hue *= 60;
    if (hue < 0) hue += 360;
  }

  return {
    h: hue,
    s: max === 0 ? 0 : delta / max,
    v: max,
  };
}

function hsvToHex(hue: number, saturation: number, value: number) {
  const chroma = value * saturation;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const match = value - chroma;
  const [red, green, blue] =
    hue < 60
      ? [chroma, x, 0]
      : hue < 120
        ? [x, chroma, 0]
        : hue < 180
          ? [0, chroma, x]
          : hue < 240
            ? [0, x, chroma]
            : hue < 300
              ? [x, 0, chroma]
              : [chroma, 0, x];

  return `#${[red, green, blue]
    .map((channel) =>
      Math.round((channel + match) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function ProviderCustomColorPanel(props: {
  readonly value: string;
  readonly onCommit: (value: string) => void;
}) {
  const { onCommit } = props;
  const initialHsv = useMemo(() => hexToHsv(props.value), [props.value]);
  const [hsv, setHsv] = useState(initialHsv);
  const currentColor = hsvToHex(hsv.h, hsv.s, hsv.v);
  const [hexInput, setHexInput] = useState(currentColor);
  const [hexInputFocused, setHexInputFocused] = useState(false);

  useEffect(() => {
    setHsv(initialHsv);
  }, [initialHsv]);

  useEffect(() => {
    if (!hexInputFocused) {
      setHexInput(currentColor);
    }
  }, [currentColor, hexInputFocused]);

  const commitHsv = useCallback(
    (nextHsv: typeof hsv) => {
      setHsv(nextHsv);
      const nextColor = hsvToHex(nextHsv.h, nextHsv.s, nextHsv.v);
      setHexInput(nextColor);
      onCommit(nextColor);
    },
    [onCommit],
  );

  const updateFromPlane = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const bounds = event.currentTarget.getBoundingClientRect();
      const saturation = clamp((event.clientX - bounds.left) / bounds.width);
      const value = 1 - clamp((event.clientY - bounds.top) / bounds.height);
      commitHsv({ ...hsv, s: saturation, v: value });
    },
    [commitHsv, hsv],
  );

  const updateFromHue = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const bounds = event.currentTarget.getBoundingClientRect();
      commitHsv({ ...hsv, h: clamp((event.clientX - bounds.left) / bounds.width) * 360 });
    },
    [commitHsv, hsv],
  );

  const handlePointerDown = (handler: (event: PointerEvent<HTMLDivElement>) => void) => {
    return (event: PointerEvent<HTMLDivElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      handler(event);
    };
  };

  return (
    <div className="w-56 bg-popover">
      <div
        className="relative h-36 cursor-crosshair touch-none"
        style={{
          backgroundColor: `hsl(${hsv.h} 100% 50%)`,
          backgroundImage:
            "linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)",
        }}
        onPointerDown={handlePointerDown(updateFromPlane)}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            updateFromPlane(event);
          }
        }}
      >
        <span
          className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.35)]"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }}
        />
      </div>
      <div className="grid gap-3 p-3">
        <div
          className="relative h-3 cursor-pointer touch-none rounded-full"
          style={{
            background: "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)",
          }}
          onPointerDown={handlePointerDown(updateFromHue)}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              updateFromHue(event);
            }
          }}
        >
          <span
            className="pointer-events-none absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.35)]"
            style={{ left: `${(hsv.h / 360) * 100}%`, backgroundColor: currentColor }}
          />
        </div>
        <input
          value={hexInput}
          onChange={(event) => {
            const nextColor = event.currentTarget.value;
            setHexInput(nextColor);
            if (!/^#[\da-f]{6}$/i.test(nextColor)) return;
            const normalized = nextColor.toLowerCase();
            setHsv(hexToHsv(normalized));
            props.onCommit(normalized);
          }}
          onFocus={() => setHexInputFocused(true)}
          onBlur={() => {
            setHexInputFocused(false);
            setHexInput(currentColor);
          }}
          className="h-8 rounded-md border border-input bg-background px-2 font-mono text-xs text-foreground outline-none transition-colors focus:border-ring"
          aria-label="Custom hex accent color"
          spellCheck={false}
        />
      </div>
    </div>
  );
}

function ProviderCustomColorPicker(props: {
  readonly displayName: string;
  readonly value: string | undefined;
  readonly selected: boolean;
  readonly onCommit: (value: string) => void;
}) {
  const normalized = normalizeProviderAccentColor(props.value) ?? FALLBACK_ACCENT_COLOR;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={cn(
              "flex size-6 cursor-pointer items-center justify-center rounded-full text-white transition-transform duration-200 active:scale-90",
              "hover:scale-105",
            )}
            style={{
              backgroundColor: normalized,
              ...(props.selected
                ? {
                    boxShadow: `inset 0 0 0 2px var(--card), 0 0 0 2px ${normalized}`,
                  }
                : {}),
            }}
            aria-label={`Choose custom accent color for ${props.displayName}`}
          >
            <PipetteIcon className="size-3 text-foreground/25" aria-hidden />
          </button>
        }
      />
      <PopoverPopup
        side="bottom"
        align="start"
        sideOffset={6}
        className="overflow-hidden rounded-md p-0 [--viewport-inline-padding:0px] [&_[data-slot=popover-viewport]]:p-0"
      >
        <ProviderCustomColorPanel value={normalized} onCommit={props.onCommit} />
      </PopoverPopup>
    </Popover>
  );
}

export function ProviderAccentColorPicker(props: {
  readonly displayName: string;
  readonly value: string | undefined;
  readonly onCommit: (value: string) => void;
  readonly description?: string;
  readonly commitDelayMs?: number;
}) {
  const { commitDelayMs = 0, description, displayName, onCommit, value } = props;
  const [optimisticValue, setOptimisticValue] = useState(() => value ?? "");
  const commitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCommitRef = useRef<string | null>(null);
  const onCommitRef = useRef(onCommit);

  useEffect(() => {
    onCommitRef.current = onCommit;
  }, [onCommit]);

  useEffect(() => {
    if (pendingCommitRef.current !== null) return;
    setOptimisticValue(value ?? "");
  }, [value]);

  useEffect(() => {
    return () => {
      if (commitTimeoutRef.current !== null) {
        clearTimeout(commitTimeoutRef.current);
      }
      const pendingCommit = pendingCommitRef.current;
      if (pendingCommit !== null) {
        onCommitRef.current(pendingCommit);
      }
    };
  }, []);

  const commitAccentColor = useCallback(
    (value: string) => {
      const normalizedValue = normalizeProviderAccentColor(value) ?? "";
      setOptimisticValue(normalizedValue);

      if (commitDelayMs <= 0) {
        pendingCommitRef.current = null;
        if (commitTimeoutRef.current !== null) {
          clearTimeout(commitTimeoutRef.current);
          commitTimeoutRef.current = null;
        }
        onCommit(normalizedValue);
        return;
      }

      pendingCommitRef.current = normalizedValue;
      if (commitTimeoutRef.current !== null) {
        clearTimeout(commitTimeoutRef.current);
      }
      commitTimeoutRef.current = setTimeout(() => {
        commitTimeoutRef.current = null;
        const pendingCommit = pendingCommitRef.current;
        pendingCommitRef.current = null;
        if (pendingCommit !== null) {
          onCommitRef.current(pendingCommit);
        }
      }, commitDelayMs);
    },
    [commitDelayMs, onCommit],
  );

  const normalized = normalizeProviderAccentColor(optimisticValue);
  const selectedValue =
    normalized &&
    PROVIDER_ACCENT_SWATCHES.includes(normalized as (typeof PROVIDER_ACCENT_SWATCHES)[number])
      ? normalized
      : "";
  const customSelected = Boolean(normalized && selectedValue === "");

  return (
    <div className="grid gap-2">
      <span className="text-xs font-medium text-foreground">Accent color</span>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <ProviderCustomColorPicker
          displayName={displayName}
          value={normalized}
          selected={customSelected}
          onCommit={commitAccentColor}
        />
        <ColorSelector
          key={selectedValue}
          colors={[...PROVIDER_ACCENT_SWATCHES]}
          defaultValue={selectedValue}
          size="lg"
          onColorSelect={commitAccentColor}
          className="flex-wrap gap-1.5"
        />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className={cn(
            "size-7 shrink-0 text-muted-foreground transition-opacity",
            normalized ? "opacity-100" : "pointer-events-none opacity-0",
          )}
          onClick={() => commitAccentColor("")}
          aria-label={`Clear accent color for ${displayName}`}
          aria-hidden={!normalized}
          tabIndex={normalized ? 0 : -1}
        >
          <XIcon className="size-3.5" aria-hidden />
        </Button>
      </div>
      {description ? <span className="text-xs text-muted-foreground">{description}</span> : null}
    </div>
  );
}
