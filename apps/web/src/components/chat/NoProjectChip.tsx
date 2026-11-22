import { useGT } from "gt-react";
import { MessageSquareDashedIcon } from "lucide-react";

import { ComposerContextLabel } from "../ComposerContextLabel";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * The tray row's lead for a thread without a project, where a git thread has
 * its workspace and branch chips. Drafts name it at the chips' size; a started
 * thread keeps the bare icon, like a locked workspace.
 */
export function NoProjectChip({ started = false }: { readonly started?: boolean }) {
  const gt = useGT();
  const noProjectLabel = gt("No project");
  if (started) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className="inline-flex h-7 shrink-0 items-center ps-2 pe-0.5 text-muted-foreground sm:h-5.5"
              data-composer-context-control
              aria-label={noProjectLabel}
            />
          }
        >
          <MessageSquareDashedIcon aria-hidden className="size-3 shrink-0" />
        </TooltipTrigger>
        <TooltipPopup>{noProjectLabel}</TooltipPopup>
      </Tooltip>
    );
  }
  return (
    <span
      // The tray chips are 12px medium at every size: caption on phones, meta above.
      className="inline-flex h-7 min-w-0 shrink-0 items-center gap-1.25 border border-transparent px-2 text-caption text-muted-foreground sm:h-5.5 sm:text-meta"
      data-composer-context-control
    >
      <MessageSquareDashedIcon aria-hidden className="size-3 shrink-0" />
      <ComposerContextLabel>{noProjectLabel}</ComposerContextLabel>
    </span>
  );
}
