"use client";

import {
  PREVIEW_VIEWPORT_MAX_AREA,
  PREVIEW_VIEWPORT_MAX_DIMENSION,
  PREVIEW_VIEWPORT_MIN_DIMENSION,
  type PreviewViewportSetting,
} from "@t3tools/contracts";
import { PREVIEW_VIEWPORT_PRESETS, resolvePreviewViewport } from "@t3tools/shared/previewViewport";
import { Link2, X } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { cn } from "~/lib/utils";

import { BROWSER_DEVICE_TOOLBAR_HEIGHT, resizeFreeformViewport } from "./browserViewportLayout";
import { commitViewportAndAspectRatio } from "./browserDeviceToolbarState";

const RESPONSIVE_VALUE = "responsive";
const SELECT_ITEMS = [
  { value: RESPONSIVE_VALUE, label: "Responsive" },
  ...PREVIEW_VIEWPORT_PRESETS.map((preset) => ({ value: preset.id, label: preset.label })),
];

function ScreenRotationIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="7.25" y="7.25" width="9.5" height="9.5" rx="1.4" transform="rotate(-45 12 12)" />
      <path d="M12.5 2a10 10 0 0 1 8.4 5.4" />
      <path d="M20.8 3.5v4h-4" />
      <path d="M11.5 22a10 10 0 0 1-8.4-5.4" />
      <path d="M3.2 20.5v-4h4" />
    </svg>
  );
}

interface Props {
  readonly setting: Exclude<PreviewViewportSetting, { readonly _tag: "fill" }>;
  readonly width: number;
  readonly aspectRatio: number | null;
  readonly onAspectRatioChange: (aspectRatio: number | null) => void;
  readonly onChange: (setting: PreviewViewportSetting) => Promise<void>;
}

export function BrowserDeviceToolbar({
  setting,
  width,
  aspectRatio,
  onAspectRatioChange,
  onChange,
}: Props) {
  const [pending, setPending] = useState(false);
  const [customSize, setCustomSize] = useState<{
    readonly width: string;
    readonly height: string;
  } | null>(null);
  const presentedSize = customSize ?? {
    width: String(setting.width),
    height: String(setting.height),
  };
  const selectedValue =
    setting._tag === "preset" &&
    PREVIEW_VIEWPORT_PRESETS.some((preset) => preset.id === setting.presetId)
      ? setting.presetId
      : RESPONSIVE_VALUE;
  const customWidth = Number(presentedSize.width);
  const customHeight = Number(presentedSize.height);
  const customValid =
    Number.isInteger(customWidth) &&
    Number.isInteger(customHeight) &&
    customWidth >= PREVIEW_VIEWPORT_MIN_DIMENSION &&
    customWidth <= PREVIEW_VIEWPORT_MAX_DIMENSION &&
    customHeight >= PREVIEW_VIEWPORT_MIN_DIMENSION &&
    customHeight <= PREVIEW_VIEWPORT_MAX_DIMENSION &&
    customWidth * customHeight <= PREVIEW_VIEWPORT_MAX_AREA;

  const apply = (next: PreviewViewportSetting, nextAspectRatio = aspectRatio) => {
    setPending(true);
    void commitViewportAndAspectRatio(next, nextAspectRatio, onChange, onAspectRatioChange).then(
      () => {
        setPending(false);
        setCustomSize(null);
      },
      () => setPending(false),
    );
  };

  const applyCustomSize = () => {
    if (!customValid || (customWidth === setting.width && customHeight === setting.height)) {
      setCustomSize(null);
      return;
    }
    apply({ _tag: "freeform", width: customWidth, height: customHeight });
  };

  const updateCustomDimension = (axis: "width" | "height", value: string) => {
    setCustomSize((current) => {
      const next = {
        width: axis === "width" ? value : (current?.width ?? String(setting.width)),
        height: axis === "height" ? value : (current?.height ?? String(setting.height)),
      };
      const numeric = Number(value);
      if (
        aspectRatio === null ||
        !Number.isInteger(numeric) ||
        numeric < PREVIEW_VIEWPORT_MIN_DIMENSION ||
        numeric > PREVIEW_VIEWPORT_MAX_DIMENSION
      ) {
        return next;
      }
      const resized = resizeFreeformViewport(
        setting,
        axis === "width"
          ? { x: numeric - setting.width, y: 0 }
          : { x: 0, y: numeric - setting.height },
        1,
        axis === "width" ? "east" : "south",
        aspectRatio,
      );
      return { width: String(resized.width), height: String(resized.height) };
    });
  };

  const selectViewport = (value: string | null) => {
    if (!value) return;
    if (value === RESPONSIVE_VALUE) {
      if (setting._tag === "freeform") return;
      apply({ _tag: "freeform", width: setting.width, height: setting.height });
      return;
    }
    const preset = PREVIEW_VIEWPORT_PRESETS.find((candidate) => candidate.id === value);
    if (!preset) return;
    apply(
      resolvePreviewViewport({ mode: "preset", preset: preset.id }),
      aspectRatio === null ? null : preset.width / preset.height,
    );
  };

  const rotate = () => {
    const hasCustomSize =
      customValid && (customWidth !== setting.width || customHeight !== setting.height);
    const source = hasCustomSize
      ? ({ _tag: "freeform", width: customWidth, height: customHeight } as const)
      : setting;
    apply(
      { ...source, width: source.height, height: source.width },
      aspectRatio === null ? null : 1 / aspectRatio,
    );
  };

  const toggleAspectRatio = () => {
    onAspectRatioChange(aspectRatio === null ? customWidth / customHeight : null);
  };

  return (
    <div
      className="sticky left-0 top-0 z-50 flex items-center gap-0.5 overflow-x-auto border-b border-border/70 bg-background/95 px-1.5 shadow-xs backdrop-blur-md [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={{ width, height: BROWSER_DEVICE_TOOLBAR_HEIGHT }}
      role="toolbar"
      aria-label="Browser device toolbar"
      data-browser-device-toolbar
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
        const eventTarget = event.target;
        if (
          (nextTarget instanceof HTMLElement &&
            nextTarget.closest('[data-slot="select-positioner"]')) ||
          (eventTarget instanceof HTMLElement &&
            eventTarget.closest('[data-slot="select-positioner"]'))
        ) {
          return;
        }
        applyCustomSize();
      }}
    >
      {width >= 560 ? (
        <span className="mr-0.5 shrink-0 text-[11px] font-medium text-muted-foreground">
          Dimensions
        </span>
      ) : null}
      <Select
        modal={false}
        value={selectedValue}
        onValueChange={selectViewport}
        items={SELECT_ITEMS}
        disabled={pending}
      >
        <SelectTrigger
          variant="ghost"
          size="xs"
          className={cn(
            "shrink-0 justify-between px-1.5 font-medium",
            width >= 440 ? "w-36" : "w-24",
          )}
          aria-label="Browser device preset"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectPopup align="start" alignItemWithTrigger={false} className="min-w-64">
          <SelectItem value={RESPONSIVE_VALUE}>Responsive</SelectItem>
          <SelectGroup>
            <SelectGroupLabel>Standard</SelectGroupLabel>
            {PREVIEW_VIEWPORT_PRESETS.map((preset) => (
              <SelectItem key={preset.id} value={preset.id}>
                <span className="flex w-full items-center justify-between gap-5">
                  <span>{preset.label}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {preset.detail}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectPopup>
      </Select>

      <form
        className="m-0 flex min-w-0 shrink-0 items-center gap-0.5 border-0 p-0"
        aria-label="Viewport dimensions"
        onSubmit={(event) => {
          event.preventDefault();
          applyCustomSize();
        }}
      >
        <Input
          nativeInput
          type="number"
          inputMode="numeric"
          size="sm"
          min={PREVIEW_VIEWPORT_MIN_DIMENSION}
          max={PREVIEW_VIEWPORT_MAX_DIMENSION}
          value={presentedSize.width}
          disabled={pending}
          onFocus={() =>
            setCustomSize(
              (current) =>
                current ?? {
                  width: String(setting.width),
                  height: String(setting.height),
                },
            )
          }
          onChange={(event) => updateCustomDimension("width", event.target.value)}
          aria-label="Viewport width"
          aria-invalid={!customValid}
          className={cn(
            "h-6 rounded-md text-center tabular-nums [&_[data-slot=input]]:h-full [&_[data-slot=input]]:px-1 [&_[data-slot=input]]:text-xs [&_[data-slot=input]]:leading-none [&_[data-slot=input]::-webkit-inner-spin-button]:appearance-none [&_[data-slot=input]]:[appearance:textfield]",
            width >= 360 ? "w-14" : "w-11",
          )}
        />
        <span className="text-xs text-muted-foreground">×</span>
        <Input
          nativeInput
          type="number"
          inputMode="numeric"
          size="sm"
          min={PREVIEW_VIEWPORT_MIN_DIMENSION}
          max={PREVIEW_VIEWPORT_MAX_DIMENSION}
          value={presentedSize.height}
          disabled={pending}
          onFocus={() =>
            setCustomSize(
              (current) =>
                current ?? {
                  width: String(setting.width),
                  height: String(setting.height),
                },
            )
          }
          onChange={(event) => updateCustomDimension("height", event.target.value)}
          aria-label="Viewport height"
          aria-invalid={!customValid}
          className={cn(
            "h-6 rounded-md text-center tabular-nums [&_[data-slot=input]]:h-full [&_[data-slot=input]]:px-1 [&_[data-slot=input]]:text-xs [&_[data-slot=input]]:leading-none [&_[data-slot=input]::-webkit-inner-spin-button]:appearance-none [&_[data-slot=input]]:[appearance:textfield]",
            width >= 360 ? "w-14" : "w-11",
          )}
        />
      </form>

      <Button
        variant="ghost"
        size="icon-xs"
        type="button"
        aria-label={
          aspectRatio === null ? "Lock viewport aspect ratio" : "Unlock viewport aspect ratio"
        }
        aria-pressed={aspectRatio !== null}
        title={aspectRatio === null ? "Lock aspect ratio" : "Unlock aspect ratio"}
        className={cn(aspectRatio !== null && "bg-accent text-foreground")}
        disabled={pending || !customValid}
        onPointerDown={(event) => event.preventDefault()}
        onClick={toggleAspectRatio}
      >
        <Link2 className={cn(aspectRatio !== null && "text-foreground")} />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        type="button"
        aria-label="Rotate viewport"
        disabled={pending}
        onClick={rotate}
      >
        <ScreenRotationIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        type="button"
        aria-label="Close device toolbar"
        className="sticky right-0 ml-auto bg-background/95"
        disabled={pending}
        onClick={() => {
          apply({ _tag: "fill" }, null);
        }}
      >
        <X />
      </Button>
    </div>
  );
}
