import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { type PullRequestUpdateMethod } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { TriangleAlertIcon } from "lucide-react";
import { type ReactNode } from "react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { MiddleTruncate } from "../ui/middle-truncate";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestGlyph } from "./pullRequestIcons";

interface BaseFreshness {
  readonly behindBy: number | null;
  readonly methods: ReadonlyArray<PullRequestUpdateMethod>;
}

function PullRequestFreshnessTrigger({
  className,
  render,
  ...props
}: useRender.ComponentProps<"button">) {
  return useRender({
    defaultTagName: "button",
    render,
    props: mergeProps<"button">(
      {
        type: "button",
        className: cn(
          "inline-flex min-w-0 shrink-0 cursor-help items-center gap-1 rounded-sm text-warning-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          className,
        ),
      },
      props,
    ),
  });
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
  const gt = useGT();
  const summary =
    freshness.behindBy === null
      ? gt("This branch is out-of-date with {baseBranch}.", { baseBranch })
      : gt(
          "{count, plural, one {This branch is out-of-date with {baseBranch} by {formatted} commit.} other {This branch is out-of-date with {baseBranch} by {formatted} commits.}}",
          {
            count: freshness.behindBy,
            formatted: freshness.behindBy.toLocaleString(),
            baseBranch,
          },
        );
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={0}
        closeDelay={120}
        render={<PullRequestFreshnessTrigger aria-label={summary} className={className} />}
      >
        {children}
        <TriangleAlertIcon aria-hidden className={cn("size-3.5 shrink-0", iconClassName)} />
      </PopoverTrigger>
      <PopoverPopup align="start" side="bottom" className="max-w-80" padding="compact">
        <p className="text-meta text-foreground">{summary}</p>
        <p className="mt-0.5 text-meta text-muted-foreground">
          <T>Changes can be cleanly merged.</T>
        </p>
        {freshness.methods.length > 0 ? (
          <span className="mt-2 flex flex-wrap items-center gap-1.5">
            {freshness.methods.map((method) => (
              <Button
                key={method}
                size="xs"
                variant="secondary"
                disabled={pending}
                onClick={() => onUpdate(method)}
              >
                <PullRequestGlyph.merged aria-hidden className="size-3" />
                {method === "rebase" ? gt("Update with rebase") : gt("Update branch")}
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
  compact = false,
}: {
  readonly baseBranch: string;
  readonly freshness: BaseFreshness | null;
  readonly stacked: boolean;
  readonly pending: boolean;
  readonly onUpdate: (method: PullRequestUpdateMethod) => void;
  readonly iconClassName?: string;
  readonly compact?: boolean;
}) {
  const gt = useGT();
  const label = (
    <>
      {stacked ? (
        <PullRequestGlyph.stack
          aria-label={gt("Stacked pull request")}
          className="size-3 shrink-0"
        />
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
          <span
            className={cn(
              "inline-flex min-w-0 max-w-[40%] shrink-0 items-center gap-1",
              compact && "@max-sm/pr-header:hidden",
            )}
          >
            {label}
          </span>
        }
      />
      <TooltipPopup side="top">
        {stacked ? gt("Stacked on {baseBranch}", { baseBranch }) : baseBranch}
      </TooltipPopup>
    </Tooltip>
  );
}
