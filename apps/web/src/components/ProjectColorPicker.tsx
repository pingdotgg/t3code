// Picks a project's accent colour in the project settings dialog. Ten swatches
// cover the common case in one click; the hue strip behind "Custom" covers the
// rest; "Auto" deletes the override and hands the project back to its derived
// default.
import { PipetteIcon, RotateCcwIcon } from "lucide-react";
import { useCallback, useEffect, useState, type CSSProperties, type PointerEvent } from "react";

import {
  MAX_PROJECT_COLOR_HUE,
  MIN_PROJECT_COLOR_HUE,
  type ProjectColorHue,
} from "@t3tools/contracts";

import {
  PROJECT_COLOR_BG_CLASS,
  PROJECT_COLOR_PALETTE,
  projectColorStyle,
} from "../lib/projectColor";
import { cn } from "../lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";

function clampHue(value: number): ProjectColorHue {
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded)) return MIN_PROJECT_COLOR_HUE as ProjectColorHue;
  return Math.min(
    MAX_PROJECT_COLOR_HUE,
    Math.max(MIN_PROJECT_COLOR_HUE, rounded),
  ) as ProjectColorHue;
}

function Swatch(props: {
  readonly hue: ProjectColorHue;
  readonly label: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.selected}
      onClick={props.onSelect}
      style={projectColorStyle(props.hue) as CSSProperties}
      className={cn(
        "size-5 shrink-0 cursor-pointer rounded-full outline-none transition-transform",
        // The ring sits outside the swatch so selection doesn't shrink the
        // colour: the swatch is a preview, and a preview that changes size
        // when picked is a worse preview.
        "ring-offset-2 ring-offset-popover focus-visible:ring-2 focus-visible:ring-ring",
        props.selected && "ring-2 ring-foreground/70",
        !props.selected && "hover:scale-110",
        PROJECT_COLOR_BG_CLASS,
      )}
    />
  );
}

export function HueStrip(props: {
  readonly hue: ProjectColorHue;
  readonly onChange: (hue: ProjectColorHue) => void;
  readonly onCommit: (hue: ProjectColorHue) => void;
}) {
  const { onChange, onCommit } = props;

  const hueFromEvent = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width === 0) return null;
    const ratio = (event.clientX - bounds.left) / bounds.width;
    return clampHue(Math.min(1, Math.max(0, ratio)) * MAX_PROJECT_COLOR_HUE);
  }, []);

  const updateFromEvent = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const nextHue = hueFromEvent(event);
      if (nextHue !== null) onChange(nextHue);
    },
    [hueFromEvent, onChange],
  );

  return (
    <div className="grid gap-2">
      <div
        role="slider"
        tabIndex={0}
        aria-label="Custom project hue"
        aria-valuemin={MIN_PROJECT_COLOR_HUE}
        aria-valuemax={MAX_PROJECT_COLOR_HUE}
        aria-valuenow={props.hue}
        className="relative h-3 cursor-pointer touch-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
        // The strip is drawn in OKLCH at the same chroma the label uses, so a
        // position on it predicts the rendered colour. An HSL rainbow would
        // over-promise: its yellows are far brighter than anything OKLCH at
        // this chroma can produce.
        style={{
          background:
            "linear-gradient(to right, oklch(0.65 0.12 0), oklch(0.65 0.12 60), oklch(0.65 0.12 120), oklch(0.65 0.12 180), oklch(0.65 0.12 240), oklch(0.65 0.12 300), oklch(0.65 0.12 359))",
        }}
        onKeyDown={(event) => {
          // Arrow keys are the only way to land an exact hue, and the only way
          // to use this at all without a pointer.
          const step = event.shiftKey ? 10 : 1;
          if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
            event.preventDefault();
            onCommit(clampHue(props.hue - step));
          } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
            event.preventDefault();
            onCommit(clampHue(props.hue + step));
          }
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          updateFromEvent(event);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            updateFromEvent(event);
          }
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            const nextHue = hueFromEvent(event);
            if (nextHue !== null) onCommit(nextHue);
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
      >
        <span
          className="pointer-events-none absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.35)]"
          style={{
            left: `${(props.hue / MAX_PROJECT_COLOR_HUE) * 100}%`,
            ...projectColorStyle(props.hue),
          }}
        />
      </div>
      <input
        type="number"
        min={MIN_PROJECT_COLOR_HUE}
        max={MAX_PROJECT_COLOR_HUE}
        value={props.hue}
        aria-label="Project hue angle"
        onChange={(event) => {
          const next = Number.parseInt(event.currentTarget.value, 10);
          if (Number.isNaN(next)) return;
          onCommit(clampHue(next));
        }}
        className="h-8 w-full rounded-md border border-input bg-background px-2 font-mono text-xs text-foreground outline-none transition-colors focus:border-ring"
        spellCheck={false}
      />
    </div>
  );
}

/**
 * Colour control for one project.
 *
 * `hue` is always the *resolved* hue — an override if one exists, otherwise the
 * derived default — so the swatches show what the sidebar shows. `hasOverride`
 * is what distinguishes "this project is deliberately blue" from "this project
 * happens to hash to blue", which is the difference Auto acts on.
 */
export function ProjectColorPicker(props: {
  readonly hue: ProjectColorHue;
  readonly hasOverride: boolean;
  readonly projectLabel: string;
  readonly onSelect: (hue: ProjectColorHue) => void;
  readonly onReset: () => void;
}) {
  const [draftHue, setDraftHue] = useState(props.hue);
  useEffect(() => setDraftHue(props.hue), [props.hue]);
  const previewHue = useCallback((hue: ProjectColorHue) => setDraftHue(hue), []);
  const commitHue = useCallback(
    (hue: ProjectColorHue) => {
      setDraftHue(hue);
      props.onSelect(hue);
    },
    [props.onSelect],
  );
  const customSelected =
    props.hasOverride && !PROJECT_COLOR_PALETTE.some((entry) => entry.hue === props.hue);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {PROJECT_COLOR_PALETTE.map((entry) => (
        <Swatch
          key={entry.id}
          hue={entry.hue}
          label={`${entry.label} for ${props.projectLabel}`}
          selected={props.hasOverride && props.hue === entry.hue}
          onSelect={() => props.onSelect(entry.hue)}
        />
      ))}

      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label={`Custom colour for ${props.projectLabel}`}
              title="Custom colour"
              className={cn(
                "inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full border border-dashed border-input text-muted-foreground outline-none transition-colors",
                "hover:border-ring hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                customSelected && "border-solid border-foreground/70 text-foreground",
              )}
            >
              <PipetteIcon className="size-3" />
            </button>
          }
        />
        <PopoverPopup side="bottom" align="start" sideOffset={6}>
          <div className="w-52">
            <HueStrip hue={draftHue} onChange={previewHue} onCommit={commitHue} />
          </div>
        </PopoverPopup>
      </Popover>

      {/* Only offered once there is something to undo: a permanently visible
        reset on a project that has never been recoloured is noise. */}
      {props.hasOverride ? (
        <button
          type="button"
          onClick={props.onReset}
          aria-label={`Reset colour for ${props.projectLabel}`}
          className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <RotateCcwIcon className="size-3" />
          Auto
        </button>
      ) : null}
    </div>
  );
}
