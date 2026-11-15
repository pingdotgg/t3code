import type { PullRequestUpdateMethod } from "@t3tools/contracts";
import { TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { MiddleTruncate } from "../ui/middle-truncate";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestGlyph } from "./pullRequestIcons";

import { translateDynamic } from "../../i18nCore";

const td = (key: string, options?: Record<string, unknown>) =>
  translateDynamic(`pullRequest:${key}`, options);

interface BaseFreshness {
  readonly behindBy: number | null;
  readonly methods: ReadonlyArray<PullRequestUpdateMethod>;
}

function PullRequestBaseFreshnessWarning({
  baseBranch,
  freshness,
  pending,
  onUpdate,
  iconClassName,
  className,
  children,
}: {
  readonly baseBranch: string;
  readonly freshness: BaseFreshness;
  readonly pending: boolean;
  readonly onUpdate: (method: PullRequestUpdateMethod) => void;
  readonly iconClassName?: string | undefined;
  readonly className?: string;
  readonly children?: ReactNode;
}) {
  const behind =
    freshness.behindBy === null
      ? ""
      : translateDynamic(
          `pullRequest:base.behindBy_${freshness.behindBy === 1 ? "one" : "other"}`,
          { formatted: freshness.behindBy.toLocaleString() },
        );
  const summary = td("base.outOfDate", { branch: baseBranch, behind });
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={0}
        closeDelay={120}
        render={
          <button
            type="button"
            aria-label={summary}
            className={cn(
              "inline-flex min-w-0 shrink-0 cursor-help items-center gap-1 rounded-sm text-warning-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              className,
            )}
          />
        }
      >
        {children}
        <TriangleAlertIcon aria-hidden className={cn("size-3.5 shrink-0", iconClassName)} />
      </PopoverTrigger>
      <PopoverPopup align="start" side="bottom" className="max-w-80" padding="compact">
        <p className="text-xs text-foreground">{summary}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">Changes can be cleanly merged.</p>
        {freshness.methods.length > 0 ? (
          <span className="mt-2 flex flex-wrap items-center gap-1.5">
            {freshness.methods.map((method) => (
              <Button
                key={method}
                size="xs"
                variant="outline"
                disabled={pending}
                onClick={() => onUpdate(method)}
              >
                <PullRequestGlyph.merged aria-hidden className="size-3" />
                {method === "rebase" ? td("base.updateWithRebase") : td("base.updateBranch")}
              </Button>
            ))}
          </span>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

/** The base branch, warning when the pull request has fallen behind it. */
export function PullRequestBaseBranch({
  baseBranch,
  freshness,
  stacked,
  pending,
  onUpdate,
  iconClassName,
}: {
  readonly baseBranch: string;
  readonly freshness: BaseFreshness | null;
  readonly stacked: boolean;
  readonly pending: boolean;
  readonly onUpdate: (method: PullRequestUpdateMethod) => void;
  readonly iconClassName?: string;
}) {
  const label = (
    <>
      {stacked ? (
        <PullRequestGlyph.stack aria-label="Stacked pull request" className="size-3 shrink-0" />
      ) : null}
      <code className="flex min-w-0">
        <MiddleTruncate value={baseBranch} showTitle={false} />
      </code>
    </>
  );
  if (freshness) {
    return (
      <PullRequestBaseFreshnessWarning
        baseBranch={baseBranch}
        freshness={freshness}
        pending={pending}
        onUpdate={onUpdate}
        iconClassName={iconClassName}
        className="max-w-[40%]"
      >
        {label}
      </PullRequestBaseFreshnessWarning>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex min-w-0 max-w-[40%] shrink-0 items-center gap-1">
            {label}
          </span>
        }
      />
      <TooltipPopup side="top">
        {stacked ? td("base.stackedOn", { branch: baseBranch }) : baseBranch}
      </TooltipPopup>
    </Tooltip>
  );
}
