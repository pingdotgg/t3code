import type { ScopedThreadRef } from "@t3tools/contracts";
import { SquarePenIcon } from "lucide-react";

import { useComposerThreadHasUnsentText } from "../composerDraftStore";
import { cn } from "../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const UNSENT_MESSAGE_LABEL = "Unsent message";

export function UnsentDraftIndicator({
  className,
  showTooltip = true,
}: {
  className?: string;
  showTooltip?: boolean;
}) {
  const indicator = (
    <span
      role="status"
      aria-label={UNSENT_MESSAGE_LABEL}
      data-testid="thread-unsent-draft-indicator"
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-amber-500/12 text-amber-700 dark:text-amber-300",
        className,
      )}
    >
      <SquarePenIcon aria-hidden className="size-2.5" />
    </span>
  );

  if (!showTooltip) return indicator;

  return (
    <Tooltip>
      <TooltipTrigger render={indicator} />
      <TooltipPopup side="top">{UNSENT_MESSAGE_LABEL}</TooltipPopup>
    </Tooltip>
  );
}

export function ThreadUnsentDraftIndicator({
  threadRef,
  ...indicatorProps
}: {
  threadRef: ScopedThreadRef;
  className?: string;
  showTooltip?: boolean;
}) {
  const hasUnsentText = useComposerThreadHasUnsentText(threadRef);
  if (!hasUnsentText) return null;

  return <UnsentDraftIndicator {...indicatorProps} />;
}
