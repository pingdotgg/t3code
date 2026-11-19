import { msg, T, useGT, useMessages } from "gt-react";
import { memo, useEffect, useState, useRef, type ReactElement } from "react";
import { m, type MessageResolver } from "../../i18n/messages";
import { isThemeColor, themeColorToHex, type ThemeColorRole } from "../../themePalette";
import { cn } from "../../lib/utils";
import { hexToHsv, hsvToHex, type HsvColor } from "../../lib/color";
import { ColorHueSlider, ColorSaturationValuePlane } from "../ui/color-picker";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
const THEME_ROLE_LABELS: Partial<Record<ThemeColorRole, string>> = {
  canvas: msg("Background"),
  toolbar: msg("Toolbar background"),
  toolbarForeground: msg("Toolbar text"),
  toolbarBorder: msg("Toolbar border"),
  toolbarControl: msg("Toolbar control"),
  toolbarControlForeground: msg("Toolbar control text"),
  toolbarControlHover: msg("Toolbar control hover"),
  accent: msg("Accent color"),
  errorForeground: msg("Error text"),
  errorSurface: msg("Error background"),
  warningForeground: msg("Warning text"),
  warningSurface: msg("Warning background"),
  updateForeground: msg("Update text"),
  updateSurface: msg("Update background"),
};

export function getThemeRoleLabel(role: ThemeColorRole, resolve: MessageResolver = m): string {
  const label = THEME_ROLE_LABELS[role];
  if (label) return resolve(label);
  return role.replace(/([A-Z])/g, " $1").replace(/^./, (character) => character.toUpperCase());
}

function themePickerAlphaSuffix(value: string): string {
  const normalized = themeColorToHex(value) ?? "";
  const alpha = normalized.length === 9 ? normalized.slice(7) : "";
  return alpha === "ff" ? "" : alpha;
}

function normalizeThemePickerColor(value: string): string {
  return (themeColorToHex(value) ?? "#000000").slice(0, 7);
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

// Local state updates immediately for a smooth thumb; the parent commit
// (which can regenerate a whole guided palette) is batched to one call per
// animation frame. The popover flushes it on close, the drag surfaces on
// release, and the picker on unmount, so the final frame is never lost.
function createFrameCommitter() {
  let pending: { readonly color: string; readonly commit: (color: string) => void } | null = null;
  let frame: number | null = null;
  const flush = () => {
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
    const next = pending;
    pending = null;
    next?.commit(next.color);
  };
  return {
    schedule(color: string, commit: (color: string) => void) {
      pending = { color, commit };
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        flush();
      });
    },
    flush,
  };
}

type FrameCommitter = ReturnType<typeof createFrameCommitter>;

function ThemeColorPickerPanel({
  label,
  value,
  committer,
  onChange,
}: {
  label: string;
  value: string;
  committer: FrameCommitter;
  onChange: (value: string) => void;
}) {
  const gt = useGT();
  const normalizedValue = normalizeThemePickerColor(value);
  const alphaSuffix = themePickerAlphaSuffix(value);
  const [hsv, setHsv] = useState(() => hexToHsv(normalizedValue));
  const [hexDraft, setHexDraft] = useState(normalizedValue);
  const [rgbDraft, setRgbDraft] = useState(() => themeRgbValue(normalizedValue));
  const [isEditingText, setIsEditingText] = useState(false);
  const [syncedValue, setSyncedValue] = useState(normalizedValue);
  const currentColor = hsvToHex(hsv.h, hsv.s, hsv.v);
  const currentRgb = themeRgbValue(currentColor);

  if (syncedValue !== normalizedValue) {
    setSyncedValue(normalizedValue);
    // Ignore readability-adjusted echoes while typing so drafts keep keystrokes; hsv still updates the
    // swatch.
    if (!isEditingText) {
      setHexDraft(normalizedValue);
      setRgbDraft(themeRgbValue(normalizedValue));
    }
    // Preserve hue/saturation for echoed changes; hex-to-HSV loses them for greys, white, and black.
    if (currentColor !== normalizedValue) setHsv(hexToHsv(normalizedValue));
  }

  const commitHsv = (nextHsv: HsvColor) => {
    setHsv(nextHsv);
    const nextColor = hsvToHex(nextHsv.h, nextHsv.s, nextHsv.v);
    setHexDraft(nextColor);
    setRgbDraft(themeRgbValue(nextColor));
    committer.schedule(nextColor + alphaSuffix, onChange);
  };

  const handleHexChange = (nextValue: string) => {
    setHexDraft(nextValue);
    if (!/^#[0-9a-f]{6}$/i.test(nextValue)) return;
    const nextHsv = hexToHsv(nextValue);
    setHsv(nextHsv);
    setRgbDraft(themeRgbValue(nextValue));
    onChange(nextValue.toLowerCase() + alphaSuffix);
  };

  const handleRgbChange = (nextValue: string) => {
    setRgbDraft(nextValue);
    const nextColor = themeRgbToHex(nextValue);
    if (!nextColor) return;
    setHsv(hexToHsv(nextColor));
    setHexDraft(nextColor);
    onChange(nextColor + alphaSuffix);
  };

  return (
    <div className="w-72">
      <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-foreground">{label}</p>
          <p className="text-2xs text-muted-foreground">
            <T>Choose a color</T>
          </p>
        </div>
        <span
          className="size-7 shrink-0 rounded-full shadow-sm"
          style={{ backgroundColor: currentColor }}
        />
      </div>
      <div className="grid gap-3 px-3 pb-3 pt-3">
        <ColorSaturationValuePlane
          label={label}
          value={hsv}
          onChange={commitHsv}
          onInteractionEnd={committer.flush}
        />
        <ColorHueSlider
          label={gt("{label} hue", { label })}
          value={hsv.h}
          onChange={(h) => commitHsv({ ...hsv, h })}
          onInteractionEnd={committer.flush}
        />
        <div className="grid grid-cols-[1fr_1.2fr] gap-2">
          <label className="grid min-w-0 gap-1">
            <span className="px-1 text-3xs font-semibold text-muted-foreground">
              {gt("Hex", { $context: "hexadecimal color value" })}
            </span>
            <span className="flex min-w-0 items-center gap-2 rounded-lg border border-input bg-background px-2 focus-within:border-ring">
              <span
                className="size-3.5 shrink-0 rounded-full"
                style={{ backgroundColor: currentColor }}
              />
              <input
                aria-label={gt("{label} picker hex value", { label })}
                className="h-8 min-w-0 flex-1 bg-transparent font-mono text-xs text-foreground outline-none"
                onBlur={() => {
                  setIsEditingText(false);
                  setHexDraft(currentColor);
                  setRgbDraft(currentRgb);
                }}
                onChange={(event) => handleHexChange(event.currentTarget.value)}
                onFocus={() => {
                  setIsEditingText(true);
                }}
                spellCheck={false}
                value={hexDraft}
              />
            </span>
          </label>
          <label className="grid min-w-0 gap-1">
            <span className="px-1 text-3xs font-semibold text-muted-foreground">RGB</span>
            <span className="flex min-w-0 items-center rounded-lg border border-input bg-background px-2 focus-within:border-ring">
              <input
                aria-label={gt("{label} picker RGB value", { label })}
                className="h-8 min-w-0 flex-1 bg-transparent font-mono text-xs text-foreground outline-none"
                onBlur={() => {
                  setIsEditingText(false);
                  setHexDraft(currentColor);
                  setRgbDraft(currentRgb);
                }}
                onChange={(event) => handleRgbChange(event.currentTarget.value)}
                onFocus={() => {
                  setIsEditingText(true);
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

/**
 * Opens the color picker from any trigger, so the editor's swatch cards,
 * list rows and the legacy round swatch share one picker.
 */
export function ThemeColorPopover({
  label,
  value,
  onChange,
  onEditStart,
  onEditCancel,
  trigger,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onEditStart?: () => void;
  onEditCancel?: () => void;
  trigger: ReactElement<Record<string, unknown>>;
}) {
  const [committer] = useState(createFrameCommitter);
  // Escape reverts the edit, so commits after it (the pending frame flushed on close, or a drag
  // still firing through the exit animation) are dropped instead of landing on the restored colors.
  const cancelledRef = useRef(false);
  // Unmounting with the popover open (the editor closes mid-drag) never fires onOpenChange.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- flushes the frame committer on unmount, since an open popover never fires onOpenChange
  useEffect(() => committer.flush, [committer]);
  return (
    <Popover
      onOpenChange={(open, eventDetails) => {
        cancelledRef.current = !open && eventDetails.reason === "escape-key";
        if (open) {
          onEditStart?.();
          return;
        }
        committer.flush();
        if (cancelledRef.current) onEditCancel?.();
      }}
    >
      <PopoverTrigger render={trigger} />
      <PopoverPopup
        align="end"
        padding="none"
        data-theme-editor-panel=""
        side="bottom"
        sideOffset={10}
      >
        <ThemeColorPickerPanel
          committer={committer}
          label={label}
          onChange={(nextValue) => {
            if (!cancelledRef.current) onChange(nextValue);
          }}
          value={value}
        />
      </PopoverPopup>
    </Popover>
  );
}

/**
 * The hex value as plain mono text that stays typeable: any CSS color the
 * theme format accepts can still be entered, not only what the picker makes.
 */
export function ThemeColorHexInput({
  label,
  value,
  onChange,
  onFocus,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onFocus?: () => void;
}) {
  const gt = useGT();
  const editorValue = value.trim().toLowerCase().startsWith("oklch(")
    ? (themeColorToHex(value) ?? value)
    : value;
  return (
    <input
      aria-invalid={!isThemeColor(value)}
      aria-label={gt("{label} hex value", { label })}
      className="w-[8.5ch] min-w-0 shrink-0 rounded-sm bg-transparent font-mono text-caption text-dim-foreground uppercase tabular-nums outline-none placeholder:normal-case hover:text-muted-foreground focus-visible:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring aria-invalid:text-destructive"
      onChange={(event) => onChange(event.currentTarget.value)}
      onFocus={onFocus}
      spellCheck={false}
      value={editorValue}
    />
  );
}

/** One color row in the advanced editor: swatch opens the picker, the label
 *  toggles where the color is used, the hex stays typeable. */
export const ThemeColorField = memo(function ThemeColorField({
  role,
  value,
  onChange,
  onEditStart,
  onEditCancel,
  onSelect,
  onToggleSelected,
  selected = false,
  label: customLabel,
}: {
  role: ThemeColorRole;
  value: string;
  onChange: (role: ThemeColorRole, value: string) => void;
  onEditStart?: (role: ThemeColorRole) => void;
  onEditCancel?: (role: ThemeColorRole) => void;
  onSelect?: (role: ThemeColorRole) => void;
  onToggleSelected?: (role: ThemeColorRole) => void;
  selected?: boolean;
  label?: string;
}) {
  const gt = useGT();
  const messages = useMessages();
  const label = customLabel ?? getThemeRoleLabel(role, messages);
  const swatchValue = isThemeColor(value) ? value : "#000000";

  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2.5 rounded-item border border-transparent px-2 py-1.5 transition-colors hover:bg-foreground/[0.04]",
        selected && "border-foreground/12 bg-foreground/6 hover:bg-foreground/6",
      )}
      data-theme-color-role={role}
    >
      <ThemeColorPopover
        onEditCancel={() => onEditCancel?.(role)}
        onEditStart={() => onEditStart?.(role)}
        label={label}
        onChange={(nextValue) => onChange(role, nextValue)}
        value={swatchValue}
        trigger={
          <button
            aria-label={gt("Choose {label} color", { label })}
            className="group flex size-4.5 shrink-0 cursor-pointer outline-none"
            onFocus={() => onSelect?.(role)}
            onPointerDown={() => onSelect?.(role)}
            type="button"
          >
            <span
              className={cn(
                "size-full rounded-badge border group-focus-visible:ring-2 group-focus-visible:ring-inset group-focus-visible:ring-ring",
                isThemeColor(value)
                  ? "border-foreground/15"
                  : "border-dashed border-destructive/70",
              )}
              style={isThemeColor(value) ? { backgroundColor: swatchValue } : undefined}
            />
          </button>
        }
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              aria-label={
                selected ? gt("Hide {label} usage", { label }) : gt("Show {label} usage", { label })
              }
              aria-pressed={selected}
              className="group flex min-w-0 flex-1 cursor-pointer text-left outline-none"
              onClick={() => onToggleSelected?.(role)}
              type="button"
            >
              <span className="truncate rounded-sm text-body text-foreground group-focus-visible:ring-2 group-focus-visible:ring-inset group-focus-visible:ring-ring">
                {label}
              </span>
            </button>
          }
        />
        <TooltipPopup side="top">
          {selected
            ? gt("Hide where {label} is used", { label })
            : gt("Show where {label} is used", { label })}
        </TooltipPopup>
      </Tooltip>
      <ThemeColorHexInput
        label={label}
        onChange={(nextValue) => onChange(role, nextValue)}
        onFocus={() => onSelect?.(role)}
        value={value}
      />
    </div>
  );
});
