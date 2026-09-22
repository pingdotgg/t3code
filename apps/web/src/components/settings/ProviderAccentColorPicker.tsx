"use client";

import { PipetteIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { hexToHsv, hsvToHex, type HsvColor } from "../../lib/color";
import { ColorHueSlider, ColorSaturationValuePlane } from "../ui/color-picker";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { Popover, PopoverClose, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { normalizeProviderAccentColor } from "../../providerInstances";
import { cn } from "../../lib/utils";

const FALLBACK_ACCENT_COLOR = "#2563eb";

function ProviderCustomColorPanel(props: {
  readonly value: string;
  readonly onCommit: (value: string) => void;
}) {
  const { onCommit } = props;
  const [hsv, setHsv] = useState(() => hexToHsv(props.value));
  const currentColor = hsvToHex(hsv.h, hsv.s, hsv.v);
  const [hexDraft, setHexDraft] = useState<string | null>(null);

  const commitHsv = useCallback(
    (nextHsv: HsvColor) => {
      setHsv(nextHsv);
      onCommit(hsvToHex(nextHsv.h, nextHsv.s, nextHsv.v));
    },
    [onCommit],
  );

  return (
    <div className="w-56 bg-popover">
      <ColorSaturationValuePlane
        label="Accent color"
        value={hsv}
        onChange={commitHsv}
        variant="edge"
      />
      <div className="grid gap-3 p-3">
        <ColorHueSlider
          label="Accent color hue"
          value={hsv.h}
          onChange={(h) => commitHsv({ ...hsv, h })}
        />
        <Input
          nativeInput
          size="sm"
          value={hexDraft ?? currentColor}
          onChange={(event) => {
            const nextColor = event.currentTarget.value;
            setHexDraft(nextColor);
            if (!/^#[\da-f]{6}$/i.test(nextColor)) return;
            setHsv(hexToHsv(nextColor));
            props.onCommit(nextColor);
          }}
          onBlur={() => setHexDraft(null)}
          font="mono"
          className="text-xs"
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
  readonly onCommit: (value: string) => void;
  readonly onClear: () => void;
}) {
  const normalized = normalizeProviderAccentColor(props.value) ?? FALLBACK_ACCENT_COLOR;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={cn(
              "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-input text-white shadow-xs transition-transform duration-200 active:scale-95",
              "hover:scale-105 hover:border-ring/60",
            )}
            style={{ backgroundColor: normalized }}
            aria-label={`Choose accent color for ${props.displayName}`}
          >
            <PipetteIcon className="size-3 text-white/70 drop-shadow-sm" aria-hidden />
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
        <PopoverClose
          render={
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 w-full justify-start rounded-none border-t border-border/60 px-3 text-xs text-muted-foreground [--control-icon-color:currentColor]"
              onClick={props.onClear}
              disabled={!props.value}
            >
              <XIcon className="size-3.5" aria-hidden />
              Clear color
            </Button>
          }
        />
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
  /** `inline` renders only the swatch row, for callers that supply their own label. */
  readonly layout?: "stacked" | "inline";
}) {
  const {
    commitDelayMs = 0,
    description,
    displayName,
    layout = "stacked",
    onCommit,
    value,
  } = props;
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
  const picker = (
    <ProviderCustomColorPicker
      displayName={displayName}
      value={normalized}
      onCommit={commitAccentColor}
      onClear={() => commitAccentColor("")}
    />
  );

  if (layout === "inline") {
    return picker;
  }

  return (
    <div className="grid gap-2">
      <span className="text-xs font-medium text-foreground">Accent color</span>
      {picker}
      {description ? <span className="text-xs text-muted-foreground">{description}</span> : null}
    </div>
  );
}
