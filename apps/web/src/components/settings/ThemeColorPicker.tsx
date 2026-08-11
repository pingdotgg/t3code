import type { KeyboardEvent, PointerEvent } from "react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { isThemeColor, themeColorToHex, type ThemeColorRole } from "../../themePalette";
import { cn } from "../../lib/utils";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
export function getThemeRoleLabel(role: ThemeColorRole): string {
  const labels: Partial<Record<ThemeColorRole, string>> = {
    canvas: "Background",
    toolbar: "Toolbar background",
    toolbarForeground: "Toolbar text",
    toolbarBorder: "Toolbar border",
    toolbarControl: "Toolbar control",
    toolbarControlForeground: "Toolbar control text",
    toolbarControlHover: "Toolbar control hover",
    accent: "Accent color",
    errorForeground: "Error text",
    errorSurface: "Error background",
    warningForeground: "Warning text",
    warningSurface: "Warning background",
    updateForeground: "Update text",
    updateSurface: "Update background",
  };
  const label = labels[role];
  if (label) return label;
  return role.replace(/([A-Z])/g, " $1").replace(/^./, (character) => character.toUpperCase());
}

type ThemeColorHsv = {
  h: number;
  s: number;
  v: number;
};

function clampThemeColor(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

/**
 * The picker remains an sRGB/hex adapter over the OKLCH palette engine. Alpha
 * is preserved separately and re-attached on commit so adjusting hue or
 * brightness cannot change transparency.
 */
function themePickerAlphaSuffix(value: string): string {
  const normalized = themeColorToHex(value) ?? "";
  const alpha = normalized.length === 9 ? normalized.slice(7) : "";
  return alpha === "ff" ? "" : alpha;
}

function normalizeThemePickerColor(value: string): string {
  return (themeColorToHex(value) ?? "#000000").slice(0, 7);
}

function themeHexToHsv(hex: string): ThemeColorHsv {
  const normalized = normalizeThemePickerColor(hex);
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

function themeHsvToHex(hue: number, saturation: number, value: number) {
  const normalizedHue = ((hue % 360) + 360) % 360;
  const chroma = value * saturation;
  const x = chroma * (1 - Math.abs(((normalizedHue / 60) % 2) - 1));
  const match = value - chroma;
  const [red, green, blue] =
    normalizedHue < 60
      ? [chroma, x, 0]
      : normalizedHue < 120
        ? [x, chroma, 0]
        : normalizedHue < 180
          ? [0, chroma, x]
          : normalizedHue < 240
            ? [0, x, chroma]
            : normalizedHue < 300
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

function themeHexToRgb(hex: string) {
  const numeric = Number.parseInt(normalizeThemePickerColor(hex).slice(1), 16);
  return [numeric >> 16, (numeric >> 8) & 255, numeric & 255] as const;
}

function themeRgbToHex(value: string): string | null {
  const normalized = value
    .trim()
    .replace(/^rgb\(\s*/i, "")
    .replace(/\s*\)$/, "");
  const channels = normalized
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(Number);
  if (
    channels.length !== 3 ||
    channels.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)
  ) {
    return null;
  }

  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function themeRgbValue(hex: string) {
  return themeHexToRgb(hex).join(", ");
}

function ThemeColorPickerPanel({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const normalizedValue = normalizeThemePickerColor(value);
  const alphaSuffix = themePickerAlphaSuffix(value);
  const [hsv, setHsv] = useState(() => themeHexToHsv(normalizedValue));
  const [hexDraft, setHexDraft] = useState(normalizedValue);
  const [rgbDraft, setRgbDraft] = useState(() => themeRgbValue(normalizedValue));
  const [isDragging, setIsDragging] = useState(false);
  const isEditingTextRef = useRef(false);
  const currentColor = themeHsvToHex(hsv.h, hsv.s, hsv.v);
  const currentRgb = themeRgbValue(currentColor);

  useEffect(() => {
    // While a text field is focused, the incoming value may be the guided
    // editor's readability-adjusted echo of what is being typed; rewriting the
    // draft would fight the keystrokes. The swatch still tracks via hsv.
    if (!isEditingTextRef.current) {
      setHexDraft(normalizedValue);
      setRgbDraft(themeRgbValue(normalizedValue));
    }
    // Keep the current hue/saturation when the incoming value is just our own
    // change echoed back; hex → HSV is lossy for greys, white, and black.
    setHsv((current) =>
      themeHsvToHex(current.h, current.s, current.v) === normalizedValue
        ? current
        : themeHexToHsv(normalizedValue),
    );
  }, [normalizedValue]);

  // Local state updates immediately for a smooth thumb; the parent commit
  // (which can regenerate a whole guided palette) is batched to one call per
  // animation frame.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const pendingCommitRef = useRef<string | null>(null);
  const commitFrameRef = useRef<number | null>(null);
  // The final drag frame must not be lost when the popover closes or the
  // pointer lifts before the animation frame fires.
  const flushPendingCommit = useCallback(() => {
    if (commitFrameRef.current !== null) {
      cancelAnimationFrame(commitFrameRef.current);
      commitFrameRef.current = null;
    }
    const pending = pendingCommitRef.current;
    pendingCommitRef.current = null;
    if (pending !== null) onChangeRef.current(pending);
  }, []);
  useEffect(() => () => flushPendingCommit(), [flushPendingCommit]);
  const scheduleCommit = useCallback((color: string) => {
    pendingCommitRef.current = color;
    commitFrameRef.current ??= requestAnimationFrame(() => {
      commitFrameRef.current = null;
      const pending = pendingCommitRef.current;
      pendingCommitRef.current = null;
      if (pending !== null) onChangeRef.current(pending);
    });
  }, []);

  const commitHsv = useCallback(
    (nextHsv: ThemeColorHsv) => {
      setHsv(nextHsv);
      const nextColor = themeHsvToHex(nextHsv.h, nextHsv.s, nextHsv.v);
      setHexDraft(nextColor);
      setRgbDraft(themeRgbValue(nextColor));
      scheduleCommit(nextColor + alphaSuffix);
    },
    [alphaSuffix, scheduleCommit],
  );

  const updateFromPlane = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const bounds = event.currentTarget.getBoundingClientRect();
      const saturation = clampThemeColor((event.clientX - bounds.left) / bounds.width);
      const value = 1 - clampThemeColor((event.clientY - bounds.top) / bounds.height);
      commitHsv({ ...hsv, s: saturation, v: value });
    },
    [commitHsv, hsv],
  );

  const updateFromHue = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const bounds = event.currentTarget.getBoundingClientRect();
      const hue = clampThemeColor((event.clientX - bounds.left) / bounds.width) * 360;
      commitHsv({ ...hsv, h: hue });
    },
    [commitHsv, hsv],
  );

  const handleHueKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 10 : 1;
    const direction = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : -1;
    if (!["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    commitHsv({ ...hsv, h: (hsv.h + direction * step + 360) % 360 });
  };

  const handlePlaneKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 0.1 : 0.02;
    const nextHsv = { ...hsv };
    if (event.key === "ArrowLeft") nextHsv.s = clampThemeColor(hsv.s - step);
    if (event.key === "ArrowRight") nextHsv.s = clampThemeColor(hsv.s + step);
    if (event.key === "ArrowUp") nextHsv.v = clampThemeColor(hsv.v + step);
    if (event.key === "ArrowDown") nextHsv.v = clampThemeColor(hsv.v - step);
    commitHsv(nextHsv);
  };

  const handlePointerDown = (handler: (event: PointerEvent<HTMLDivElement>) => void) => {
    return (event: PointerEvent<HTMLDivElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      setIsDragging(true);
      handler(event);
    };
  };

  const stopDragging = () => {
    setIsDragging(false);
    flushPendingCommit();
  };

  // Thumbs travel inside the control by half their own size so they never
  // clip at the extremes; movement only animates for keyboard steps and
  // click-to-jump, never while dragging.
  const thumbTransition = isDragging
    ? undefined
    : "left 80ms linear, top 80ms linear, background-color 80ms linear";

  const handleHexChange = (nextValue: string) => {
    setHexDraft(nextValue);
    if (!/^#[0-9a-f]{6}$/i.test(nextValue)) return;
    const nextHsv = themeHexToHsv(nextValue);
    setHsv(nextHsv);
    setRgbDraft(themeRgbValue(nextValue));
    onChange(nextValue.toLowerCase());
  };

  const handleRgbChange = (nextValue: string) => {
    setRgbDraft(nextValue);
    const nextColor = themeRgbToHex(nextValue);
    if (!nextColor) return;
    setHsv(themeHexToHsv(nextColor));
    setHexDraft(nextColor);
    // RGB cannot express alpha, so a commit keeps the incoming suffix just
    // like the plane and hue controls do.
    onChange(nextColor + alphaSuffix);
  };

  return (
    <div className="w-72 bg-popover">
      <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-foreground">{label}</p>
          <p className="text-[11px] text-muted-foreground">Choose a color</p>
        </div>
        <span
          className="size-7 shrink-0 rounded-full shadow-sm"
          style={{ backgroundColor: currentColor }}
        />
      </div>
      <div className="grid gap-3 px-3 pb-3 pt-3">
        <div
          aria-label={`${label} saturation and brightness`}
          aria-valuetext={`saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
          className="relative h-32 cursor-crosshair touch-none overflow-hidden rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover"
          role="slider"
          style={{
            backgroundColor: `hsl(${hsv.h} 100% 50%)`,
            backgroundImage:
              "linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)",
          }}
          tabIndex={0}
          onKeyDown={handlePlaneKeyDown}
          onLostPointerCapture={stopDragging}
          onPointerDown={handlePointerDown(updateFromPlane)}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) updateFromPlane(event);
          }}
          onPointerUp={stopDragging}
        >
          <span
            className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.4)]"
            style={{
              left: `calc(${hsv.s} * (100% - 0.75rem) + 0.375rem)`,
              top: `calc(${1 - hsv.v} * (100% - 0.75rem) + 0.375rem)`,
              transition: thumbTransition,
            }}
          />
        </div>
        <div
          aria-label={`${label} hue`}
          aria-valuemax={360}
          aria-valuemin={0}
          aria-valuenow={Math.round(hsv.h)}
          className="relative flex h-6 cursor-pointer touch-none items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover"
          role="slider"
          tabIndex={0}
          onKeyDown={handleHueKeyDown}
          onLostPointerCapture={stopDragging}
          onPointerDown={handlePointerDown(updateFromHue)}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) updateFromHue(event);
          }}
          onPointerUp={stopDragging}
        >
          <span
            aria-hidden
            className="h-2.5 w-full rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0_/_12%)]"
            style={{
              background: "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)",
            }}
          />
          <span
            className="pointer-events-none absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.4)]"
            style={{
              left: `calc(${hsv.h / 360} * (100% - 1rem) + 0.5rem)`,
              // The ball shows the pure hue so it stays visually anchored to
              // the track; the header swatch carries the full current color.
              backgroundColor: `hsl(${hsv.h} 100% 50%)`,
              transition: thumbTransition,
            }}
          />
        </div>
        <div className="grid grid-cols-[1fr_1.2fr] gap-2">
          <label className="grid min-w-0 gap-1">
            <span className="px-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              HEX
            </span>
            <span className="flex min-w-0 items-center gap-2 rounded-lg border border-input bg-background px-2 focus-within:border-ring">
              <span
                className="size-3.5 shrink-0 rounded-full"
                style={{ backgroundColor: currentColor }}
              />
              <input
                aria-label={`${label} picker hex value`}
                className="h-8 min-w-0 flex-1 bg-transparent font-mono text-xs text-foreground outline-none"
                onBlur={() => {
                  isEditingTextRef.current = false;
                  setHexDraft(currentColor);
                  setRgbDraft(currentRgb);
                }}
                onChange={(event) => handleHexChange(event.currentTarget.value)}
                onFocus={() => {
                  isEditingTextRef.current = true;
                }}
                spellCheck={false}
                value={hexDraft}
              />
            </span>
          </label>
          <label className="grid min-w-0 gap-1">
            <span className="px-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              RGB
            </span>
            <span className="flex min-w-0 items-center rounded-lg border border-input bg-background px-2 focus-within:border-ring">
              <input
                aria-label={`${label} picker RGB value`}
                className="h-8 min-w-0 flex-1 bg-transparent font-mono text-xs text-foreground outline-none"
                onBlur={() => {
                  isEditingTextRef.current = false;
                  setHexDraft(currentColor);
                  setRgbDraft(currentRgb);
                }}
                onChange={(event) => handleRgbChange(event.currentTarget.value)}
                onFocus={() => {
                  isEditingTextRef.current = true;
                }}
                spellCheck={false}
                value={rgbDraft}
              />
            </span>
          </label>
        </div>
      </div>
    </div>
  );
}

function ThemeColorPicker({
  label,
  value,
  onChange,
  onInteract,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onInteract?: () => void;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            aria-label={`Choose ${label} color`}
            className="relative flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full border border-foreground/30 transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            onFocus={onInteract}
            onPointerDown={onInteract}
            title={`Choose ${label} color`}
            type="button"
          >
            <span
              className="absolute inset-0 rounded-full shadow-sm"
              style={{ backgroundColor: value }}
            />
          </button>
        }
      />
      <PopoverPopup
        align="end"
        className="overflow-hidden rounded-2xl border border-border/70 p-0 shadow-2xl [--viewport-inline-padding:0px] [&_[data-slot=popover-viewport]]:p-0"
        data-theme-editor-panel=""
        side="bottom"
        sideOffset={10}
      >
        <ThemeColorPickerPanel label={label} onChange={onChange} value={value} />
      </PopoverPopup>
    </Popover>
  );
}

export const ThemeColorField = memo(function ThemeColorField({
  role,
  value,
  onChange,
  onSelect,
  onToggleSelected,
  selected = false,
  label: customLabel,
}: {
  role: ThemeColorRole;
  value: string;
  onChange: (role: ThemeColorRole, value: string) => void;
  onSelect?: (role: ThemeColorRole) => void;
  onToggleSelected?: (role: ThemeColorRole) => void;
  selected?: boolean;
  label?: string;
}) {
  const label = customLabel ?? getThemeRoleLabel(role);
  const isColorValue = isThemeColor(value);
  const swatchValue = isColorValue ? value : "#000000";
  const editorValue = value.trim().toLowerCase().startsWith("oklch(")
    ? (themeColorToHex(value) ?? value)
    : value;

  return (
    <div
      className={cn(
        "flex min-h-11 min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 transition-[background-color,box-shadow]",
        selected && "bg-accent/60 shadow-[inset_0_0_0_1px_var(--ring)]",
      )}
      data-theme-color-role={role}
    >
      <button
        aria-label={`${selected ? "Hide" : "Show"} ${label} usage`}
        aria-pressed={selected}
        className="flex min-w-0 flex-1 cursor-pointer items-center rounded-md text-left text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => onToggleSelected?.(role)}
        title={`${selected ? "Hide" : "Show"} where ${label} is used`}
        type="button"
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </button>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <ThemeColorPicker
          label={label}
          onChange={(nextValue) => onChange(role, nextValue)}
          onInteract={() => onSelect?.(role)}
          value={swatchValue}
        />
        <Input
          aria-invalid={!isColorValue}
          aria-label={`${label} hex value`}
          className="w-28 shrink-0 rounded-md border-0 bg-black/10 font-mono text-xs text-foreground shadow-none focus-within:bg-black/15 focus-within:ring-0 dark:bg-black/20 dark:focus-within:bg-black/25 [&_[data-slot=input]]:text-right"
          id={`${role}-hex`}
          nativeInput
          onChange={(event) => onChange(role, event.currentTarget.value)}
          onFocus={() => onSelect?.(role)}
          onPointerDown={() => onSelect?.(role)}
          size="sm"
          unstyled
          value={editorValue}
        />
      </div>
    </div>
  );
});
