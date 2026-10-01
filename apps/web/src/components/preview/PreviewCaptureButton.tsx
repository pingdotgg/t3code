import { Camera } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

export function PreviewCaptureButton({
  recording = false,
  disabled = false,
  onCapture,
}: {
  recording?: boolean | undefined;
  disabled?: boolean | undefined;
  onCapture: (record: boolean) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={recording ? "secondary" : "ghost"}
            size="icon-xs"
            onClick={(event) => onCapture(event.shiftKey)}
            aria-label={recording ? "Stop recording" : "Capture screenshot"}
            type="button"
            className="relative"
            disabled={disabled}
          />
        }
      >
        <Camera className={cn(recording && "text-destructive")} />
        {recording ? (
          <span className="absolute right-0.5 top-0.5 size-1.5 animate-status-pulse rounded-full bg-destructive" />
        ) : null}
      </TooltipTrigger>
      <TooltipPopup>
        {recording ? "Stop recording" : "Screenshot · Shift-click to record"}
      </TooltipPopup>
    </Tooltip>
  );
}
