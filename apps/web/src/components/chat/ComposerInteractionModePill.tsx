import type { ProviderInteractionMode } from "@forma/contracts";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { composerInteractionModeConfig } from "./composerInteractionMode";

export const ComposerInteractionModePill = memo(function ComposerInteractionModePill(props: {
  interactionMode: ProviderInteractionMode;
}) {
  const option = composerInteractionModeConfig[props.interactionMode];
  const OptionIcon = option.icon;

  return (
    <div
      className={cn(
        "inline-flex h-6.5 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-sm shadow-xs/5 mx-2",
        option.pillClassName,
      )}
      data-composer-interaction-mode-pill={props.interactionMode}
    >
      <OptionIcon className="size-3 shrink-0 fill-current" />
      <span className="truncate font-medium">{option.label}</span>
    </div>
  );
});
