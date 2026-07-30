import type { FormaInteractionMode } from "@t3tools/contracts";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { composerInteractionModeConfig } from "./composerInteractionMode";

export const ComposerInteractionModePill = memo(function ComposerInteractionModePill(props: {
  interactionMode: FormaInteractionMode;
  onClick?: () => void;
}) {
  const option = composerInteractionModeConfig[props.interactionMode];
  const OptionIcon = option.icon;
  const className = cn(
    "mx-2 inline-flex h-6.5 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-sm shadow-xs/5",
    props.onClick &&
      "cursor-pointer transition-opacity [transition-duration:var(--motion-duration-micro)] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/60 active:scale-[0.97]",
    option.pillClassName,
  );
  const contents = (
    <>
      <OptionIcon className="size-3 shrink-0 fill-current" />
      <span className="truncate font-medium">{option.label}</span>
    </>
  );

  if (!props.onClick) {
    return (
      <div className={className} data-composer-interaction-mode-pill={props.interactionMode}>
        {contents}
      </div>
    );
  }

  return (
    <button
      type="button"
      className={className}
      data-composer-interaction-mode-pill={props.interactionMode}
      onClick={props.onClick}
    >
      {contents}
    </button>
  );
});
