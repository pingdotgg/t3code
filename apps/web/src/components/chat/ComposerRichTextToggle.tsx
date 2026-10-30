import { FeatherIcon } from "lucide-react";

import { updateClientSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

// Same setting as Settings → Chat → Rich text composer. Flipping it remounts the
// editor; pointer-down is swallowed so a focused editor keeps its caret across that.
export function ComposerRichTextToggle({
  richTextEnabled,
  shortcutLabel,
}: {
  readonly richTextEnabled: boolean;
  readonly shortcutLabel: string | null;
}) {
  const showingSource = !richTextEnabled;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Markdown source"
            aria-pressed={showingSource}
            data-pressed={showingSource ? "" : undefined}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => void updateClientSettings({ composerRichTextEnabled: showingSource })}
          />
        }
      >
        <FeatherIcon />
      </TooltipTrigger>
      <TooltipPopup>
        {showingSource ? "Show formatting" : "Show Markdown source"}
        {shortcutLabel ? ` · ${shortcutLabel}` : null}
      </TooltipPopup>
    </Tooltip>
  );
}
