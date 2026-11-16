import { nextFileZoom } from "./fileZoom";
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
  disabled?: boolean;
}) {
  const actions = use(FilePreviewActions);
  return (
    <>
      <FileSurfaceAction
        label="Zoom out"
        disabled={props.disabled || props.zoom <= props.min}
        onPress={() => props.onChange(nextFileZoom(props.zoom, -1, props.min, props.max))}
      >
        <MinusIcon className="size-3.5" />
      </FileSurfaceAction>
      <span className="min-w-14 text-center font-medium tabular-nums">
        {props.displayValue ?? `${Math.round(props.zoom * 100)}%`}
      </span>
      <FileSurfaceAction
        label="Zoom in"
        disabled={props.disabled || props.zoom >= props.max}
        onPress={() => props.onChange(nextFileZoom(props.zoom, 1, props.min, props.max))}
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
