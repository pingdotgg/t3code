import { memo } from "react";

import { cn } from "~/lib/utils";

import type { ThreadContextUsageSnapshot } from "../../session-logic";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuPopup, MenuSeparator as MenuDivider, MenuTrigger } from "../ui/menu";
import { buildComposerContextUsageIndicatorViewModel } from "./ComposerContextUsageIndicator.logic";

const RING_RADIUS = 6;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export const ComposerContextUsageIndicator = memo(function ComposerContextUsageIndicator({
  snapshot,
}: {
  snapshot: ThreadContextUsageSnapshot | null;
}) {
  const viewModel = buildComposerContextUsageIndicatorViewModel(snapshot);
  const ringToneClass =
    viewModel.severity === "danger"
      ? "stroke-rose-500"
      : viewModel.severity === "warning"
        ? "stroke-amber-500"
        : "stroke-muted-foreground/80";
  const progressPercent = viewModel.progressPercent;
  const dashOffset =
    progressPercent === null
      ? RING_CIRCUMFERENCE
      : RING_CIRCUMFERENCE * (1 - Math.max(0, Math.min(progressPercent, 100)) / 100);

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            aria-label={viewModel.ariaLabel}
            className="relative inline-flex size-7 shrink-0 px-0 text-muted-foreground/75 hover:text-foreground/80"
          />
        }
      >
        <svg
          aria-hidden="true"
          className="size-4 -rotate-90"
          viewBox="0 0 16 16"
          fill="none"
          focusable="false"
        >
          <circle
            cx="8"
            cy="8"
            r={RING_RADIUS}
            className="stroke-border/80"
            strokeWidth="1.5"
            fill="none"
          />
          {progressPercent !== null ? (
            <circle
              cx="8"
              cy="8"
              r={RING_RADIUS}
              className={cn("transition-[stroke-dashoffset,stroke] duration-200", ringToneClass)}
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={dashOffset}
              fill="none"
            />
          ) : null}
        </svg>
        {viewModel.showCompactionNotice ? (
          <span
            aria-hidden="true"
            className="absolute right-1 top-1 size-1.5 rounded-full bg-amber-500 ring-1 ring-background"
          />
        ) : null}
      </MenuTrigger>
      <MenuPopup side="top" align="start" className="max-w-72">
        <MenuGroup>
          <div className="px-2 pt-1.5 pb-0.5 text-muted-foreground text-xs">Context window:</div>
          <div className="px-2 pb-0.5 font-medium text-foreground text-sm leading-tight">
            {viewModel.summaryLine}
          </div>
          <div className="px-2 pb-1.5 text-foreground text-sm leading-tight">
            {viewModel.tokensLine}
          </div>
          {viewModel.showCompactionNotice ? (
            <>
              <MenuDivider />
              <div className="px-2 py-1.5 text-amber-600 text-xs leading-tight">
                Context was compacted recently.
              </div>
            </>
          ) : null}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
});
