// Fork: small controls the theme studio's sections share: a slider row, a hex colour picker and
// a colour row.
import { useGT } from "gt-react";
import { useState, type CSSProperties, type ReactNode } from "react";

import { hexToHsv, hsvToHex } from "../../lib/color";
import { ColorHueSlider, ColorSaturationValuePlane } from "../ui/color-picker";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SettingResetButton, SettingsRow } from "../settings/settingsLayout";

const HEX = /^#[\da-f]{6}$/i;

export function StudioSliderRow(props: {
  readonly id: string;
  readonly title: string;
  readonly description?: ReactNode;
  readonly value: number;
  readonly limits: readonly [number, number];
  readonly step?: number;
  readonly unit?: string;
  readonly defaultValue?: number;
  readonly onChange: (value: number) => void;
}) {
  const gt = useGT();
  const [min, max] = props.limits;
  const progress = ((props.value - min) / (max - min)) * 100;
  const style = {
    "--settings-slider-progress": `${progress}%`,
    "--settings-slider-fill-offset": `${0.5 - progress / 100}rem`,
  } as CSSProperties;
  return (
    <SettingsRow
      title={props.title}
      description={props.description}
      resetAction={
        props.defaultValue !== undefined && props.value !== props.defaultValue ? (
          <SettingResetButton
            ariaLabel={gt("Reset {setting} to default", { setting: props.title })}
            onClick={() => props.onChange(props.defaultValue!)}
          />
        ) : null
      }
      control={
        <div className="flex w-full items-center gap-3 sm:w-52">
          <output
            className="min-w-14 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
            htmlFor={props.id}
          >
            {props.value}
            {props.unit}
          </output>
          <input
            aria-label={props.title}
            className="settings-slider min-w-0 flex-1"
            id={props.id}
            max={max}
            min={min}
            step={props.step ?? 1}
            style={style}
            type="range"
            value={props.value}
            onChange={(event) => {
              const next = Number(event.currentTarget.value);
              if (Number.isFinite(next) && next >= min && next <= max) props.onChange(next);
            }}
          />
        </div>
      }
    />
  );
}

/** A saturation plane, hue slider and hex field; every change commits a `#rrggbb`. */
export function StudioColorPicker(props: {
  readonly label: string;
  readonly value: string;
  readonly onCommit: (value: string) => void;
}) {
  const gt = useGT();
  const [hsv, setHsv] = useState(() => hexToHsv(props.value));
  const current = hsvToHex(hsv.h, hsv.s, hsv.v);
  const [synced, setSynced] = useState(props.value);
  const [draft, setDraft] = useState<string | null>(null);
  if (synced !== props.value) {
    setSynced(props.value);
    if (current !== props.value.toLowerCase()) setHsv(hexToHsv(props.value));
  }
  const change = (next: typeof hsv) => {
    setHsv(next);
    props.onCommit(hsvToHex(next.h, next.s, next.v));
  };
  return (
    <div className="w-56 bg-popover">
      <ColorSaturationValuePlane label={props.label} value={hsv} onChange={change} variant="edge" />
      <div className="grid gap-3 p-3">
        <ColorHueSlider
          label={gt("{label} hue", { label: props.label })}
          value={hsv.h}
          onChange={(h) => change({ ...hsv, h })}
        />
        <Input
          nativeInput
          size="compact"
          font="mono"
          spellCheck={false}
          aria-label={gt("{label} hex value", { label: props.label })}
          value={draft ?? current}
          onChange={(event) => {
            const next = event.currentTarget.value;
            setDraft(next);
            if (!HEX.test(next)) return;
            setHsv(hexToHsv(next));
            props.onCommit(next.toLowerCase());
          }}
          onBlur={() => setDraft(null)}
        />
      </div>
    </div>
  );
}

export function StudioColorSwatchButton(props: {
  readonly label: string;
  readonly color: string;
  readonly children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={props.label}
            className="size-7 shrink-0 cursor-pointer rounded-md ring-1 ring-inset ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            style={{ backgroundColor: props.color }}
          />
        }
      />
      <PopoverPopup side="bottom" align="end" sideOffset={6} padding="none">
        {props.children}
      </PopoverPopup>
    </Popover>
  );
}

/** One editable theme colour: name, swatch (opens the picker) and hex field. */
export function StudioColorRow(props: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const gt = useGT();
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <div className="flex min-h-10 items-center gap-2 px-3 py-1 sm:px-4">
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{props.label}</span>
      <StudioColorSwatchButton
        label={gt("Pick {label}", { label: props.label })}
        color={props.value}
      >
        <StudioColorPicker label={props.label} value={props.value} onCommit={props.onChange} />
      </StudioColorSwatchButton>
      <Input
        nativeInput
        size="compact"
        font="mono"
        spellCheck={false}
        className="w-24 shrink-0"
        aria-label={gt("{label} hex value", { label: props.label })}
        aria-invalid={draft !== null && !HEX.test(draft)}
        value={draft ?? props.value}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setDraft(next);
          if (HEX.test(next)) props.onChange(next.toLowerCase());
        }}
        onBlur={() => setDraft(null)}
      />
    </div>
  );
}
