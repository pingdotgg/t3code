import { ArrowLeftRightIcon, MinusIcon, PlusIcon } from "lucide-react";
import { useId, type CSSProperties } from "react";

import { THREAD_WIDTH_STEP, useFitTables, useThreadWidth } from "~/hooks/useThreadWidth";
import { Switch } from "../ui/switch";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";

/** Adjust conversation width and optional table wrapping without leaving the thread. */
export function ThreadWidthControl() {
  const [expansion, setExpansion] = useThreadWidth();
  const sliderId = useId();
  const fitId = useId();
  const [fitTables, setFitTables] = useFitTables();
  const sliderStyle = {
    "--settings-slider-progress": `${expansion}%`,
    "--settings-slider-fill-offset": `${0.5 - expansion / 100}rem`,
  } as CSSProperties;

  return (
    <Popover>
      <PopoverTrigger
        data-toolbar-control
        render={
          <Button
            size="xs"
            variant="outline"
            aria-label={`Thread width: ${expansion}%`}
            className="gap-1 data-popup-open:border-primary/50 data-popup-open:bg-accent"
          />
        }
      >
        <ArrowLeftRightIcon aria-hidden="true" className="size-3.5" />
        <span className="hidden @3xl/header-actions:inline">Width</span>
        <span className="tabular-nums">{expansion}%</span>
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-64" viewportClassName="space-y-3">
        <PopoverTitle className="text-sm">Thread width</PopoverTitle>
        <div className="flex items-center justify-between gap-3">
          <Button
            aria-label="Decrease thread width"
            size="icon-xs"
            variant="outline"
            disabled={expansion === 0}
            onClick={() => setExpansion(expansion - THREAD_WIDTH_STEP)}
          >
            <MinusIcon aria-hidden="true" />
          </Button>
          <output htmlFor={sliderId} className="text-sm tabular-nums">
            {expansion}%
          </output>
          <Button
            aria-label="Increase thread width"
            size="icon-xs"
            variant="outline"
            disabled={expansion === 100}
            onClick={() => setExpansion(expansion + THREAD_WIDTH_STEP)}
          >
            <PlusIcon aria-hidden="true" />
          </Button>
        </div>
        <div>
          <input
            id={sliderId}
            aria-label="Thread width"
            className="settings-slider block w-full"
            type="range"
            min={0}
            max={100}
            step={THREAD_WIDTH_STEP}
            value={expansion}
            style={sliderStyle}
            onChange={(event) => setExpansion(Number(event.currentTarget.value))}
          />
          <div className="flex justify-between text-xs text-muted-foreground" aria-hidden="true">
            <span>0%</span>
            <span>100%</span>
          </div>
        </div>
        <label
          htmlFor={fitId}
          className="flex cursor-pointer items-center justify-between gap-3 border-t border-border pt-3 text-sm"
        >
          Fit tables
          <Switch id={fitId} size="sm" checked={fitTables} onCheckedChange={setFitTables} />
        </label>
      </PopoverPopup>
    </Popover>
  );
}
