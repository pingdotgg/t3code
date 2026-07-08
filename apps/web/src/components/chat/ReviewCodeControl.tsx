import type { ReviewChangesScope } from "@t3tools/contracts";
import {
  ClipboardCheckIcon,
  ChevronDownIcon,
  GitCompareArrowsIcon,
  LoaderIcon,
} from "lucide-react";

import { Button } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const REVIEW_SCOPE_LABELS = {
  uncommitted: "Review uncommitted changes",
  "against-base": "Review against base branch",
} as const satisfies Record<ReviewChangesScope, string>;

function ReviewScopeIcon({ scope, className }: { scope: ReviewChangesScope; className: string }) {
  if (scope === "against-base") {
    return <GitCompareArrowsIcon className={className} />;
  }
  return <ClipboardCheckIcon className={className} />;
}

interface ReviewCodeControlProps {
  readonly defaultScope: ReviewChangesScope;
  readonly disabledReason: string | null;
  readonly isRunning: boolean;
  readonly onReview: (scope: ReviewChangesScope) => void;
}

export function ReviewCodeControl({
  defaultScope,
  disabledReason,
  isRunning,
  onReview,
}: ReviewCodeControlProps) {
  const disabled = isRunning || disabledReason !== null;
  const defaultLabel = REVIEW_SCOPE_LABELS[defaultScope];
  const tooltip = disabledReason ?? (isRunning ? "Starting review..." : defaultLabel);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Group aria-label="Review Code">
            <Button
              size="icon-xs"
              variant="outline"
              className="border-transparent px-0 shadow-none hover:border-input hover:shadow-xs/5"
              onClick={() => onReview(defaultScope)}
              disabled={disabled}
              aria-label={defaultLabel}
            >
              {isRunning ? (
                <LoaderIcon className="size-3 animate-spin" />
              ) : (
                <ReviewScopeIcon scope={defaultScope} className="size-3" />
              )}
              <span className="sr-only">{defaultLabel}</span>
            </Button>
            <GroupSeparator />
            <Menu highlightItemOnHover={false}>
              <MenuTrigger
                render={
                  <Button
                    size="icon-xs"
                    className="size-6 border-transparent px-0 shadow-none hover:border-input hover:shadow-xs/5"
                    variant="outline"
                    aria-label="Review Code options"
                    disabled={disabled}
                  />
                }
              >
                <ChevronDownIcon className="size-3" />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={() => onReview("uncommitted")}>
                  <ClipboardCheckIcon className="size-4" />
                  Review uncommitted changes
                </MenuItem>
                <MenuItem onClick={() => onReview("against-base")}>
                  <GitCompareArrowsIcon className="size-4" />
                  Review against base branch
                </MenuItem>
              </MenuPopup>
            </Menu>
          </Group>
        }
      />
      <TooltipPopup side="bottom">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
