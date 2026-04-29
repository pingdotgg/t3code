import type { ProviderInteractionMode } from "@forma/contracts";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { composerInteractionModeConfig } from "./composerInteractionMode";

export const ComposerInteractionModePill = memo(function ComposerInteractionModePill(props: {
  interactionMode: ProviderInteractionMode;
  onClick?: () => void;
}) {
  const option = composerInteractionModeConfig[props.interactionMode];
  const OptionIcon = option.icon;
  const pillClassName = cn(
    "inline-flex h-6.5 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-sm shadow-xs/5 mx-2",
    props.onClick
      ? "cursor-pointer transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/60"
      : null,
    option.pillClassName,
  );
  const pillContents = (
    <>
      <OptionIcon className="size-3 shrink-0 fill-current" />
      <span className="truncate font-medium">{option.label}</span>
    </>
  );

  if (props.onClick) {
    return (
      <button
        type="button"
        className={pillClassName}
        data-composer-interaction-mode-pill={props.interactionMode}
        onClick={props.onClick}
      >
        {pillContents}
      </button>
    );
  }

  return (
    <div className={pillClassName} data-composer-interaction-mode-pill={props.interactionMode}>
      {pillContents}
    </div>
  );
});
