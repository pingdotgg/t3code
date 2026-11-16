import { use } from "react";
import { FilePreviewActions } from "./FilePreviewActions";
import { MinusIcon, PlusIcon, ScanIcon } from "lucide-react";
import { FileSurfaceAction } from "./fileSurfaceChrome";

export const FILE_ZOOM_TOOLBAR_CLASS =
  "flex min-h-10 shrink-0 flex-wrap items-center gap-1 border-b border-border/60 px-2 py-1 text-xs";

export function FileZoomControls(props: {
  zoom: number;
  min: number;
  max: number;
  onChange: (zoom: number) => void;
  onReset: () => void;
  resetLabel?: string;
  displayValue?: string | undefined;
  sliderLabel?: string;
  disabled?: boolean;
}) {
  const actions = use(FilePreviewActions);
  return (
    <>
      <FileSurfaceAction
        label="Zoom out"
        disabled={props.disabled || props.zoom <= props.min}
        onPress={() => props.onChange(Math.max(props.min, props.zoom - 0.25))}
      >
        <MinusIcon className="size-3.5" />
      </FileSurfaceAction>
      <span className="min-w-14 text-center font-medium tabular-nums">
        {props.displayValue ?? `${Math.round(props.zoom * 100)}%`}
      </span>
      {props.sliderLabel ? (
        <input
          type="range"
          aria-label={props.sliderLabel}
          min={props.min * 100}
          max={props.max * 100}
          step={1}
          value={Math.round(props.zoom * 100)}
          disabled={props.disabled ?? false}
          onChange={(event) => props.onChange(Number(event.target.value) / 100)}
          className="h-1 w-24 accent-foreground"
        />
      ) : null}
      <FileSurfaceAction
        label="Zoom in"
        disabled={props.disabled || props.zoom >= props.max}
        onPress={() => props.onChange(Math.min(props.max, props.zoom + 0.25))}
      >
        <PlusIcon className="size-3.5" />
      </FileSurfaceAction>
      <FileSurfaceAction
        label={props.resetLabel ?? "Reset zoom to 100%"}
        disabled={props.disabled ?? false}
        onPress={props.onReset}
      >
        <ScanIcon className="size-3.5" />
      </FileSurfaceAction>
      {actions}
    </>
  );
}
