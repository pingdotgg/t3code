import { CircleDotIcon, X } from "lucide-react";

import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "../composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { type LinearIssueContextDraft, formatLinearIssueLabel } from "~/lib/linearIssueContext";

interface ComposerPendingLinearIssuesProps {
  issues: ReadonlyArray<LinearIssueContextDraft>;
  onRemove: (contextId: string) => void;
  className?: string;
}

interface ComposerPendingLinearIssueChipProps {
  issue: LinearIssueContextDraft;
  onRemove: (contextId: string) => void;
}

function buildTooltipContent(issue: LinearIssueContextDraft): string {
  const lines: string[] = [];
  lines.push(issue.title);
  if (issue.stateName) lines.push(issue.stateName);
  return lines.join("\n");
}

export function ComposerPendingLinearIssueChip({
  issue,
  onRemove,
}: ComposerPendingLinearIssueChipProps) {
  const label = formatLinearIssueLabel(issue);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className={cn(COMPOSER_INLINE_CHIP_CLASS_NAME, "pr-1")}>
            <CircleDotIcon className={cn(COMPOSER_INLINE_CHIP_ICON_CLASS_NAME, "size-3.5")} />
            <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{label}</span>
            <button
              type="button"
              aria-label={`Remove ${label}`}
              className={COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onRemove(issue.id);
              }}
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap leading-tight">
        {buildTooltipContent(issue)}
      </TooltipPopup>
    </Tooltip>
  );
}

export function ComposerPendingLinearIssues({
  issues,
  onRemove,
  className,
}: ComposerPendingLinearIssuesProps) {
  if (issues.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {issues.map((issue) => (
        <ComposerPendingLinearIssueChip key={issue.id} issue={issue} onRemove={onRemove} />
      ))}
    </div>
  );
}
