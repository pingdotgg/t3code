import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { type PullRequestUpdateMethod } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { TriangleAlertIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { MiddleTruncate } from "../ui/middle-truncate";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
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

/** The amber mark beside the head branch when it has fallen behind its base. */
export function PullRequestBaseFreshnessWarning({
  baseBranch,
  freshness,
  pending,
  onUpdate,
  iconClassName,
  className,
}: {
  readonly baseBranch: string;
  readonly freshness: BaseFreshness;
  readonly pending: boolean;
  readonly onUpdate: (method: PullRequestUpdateMethod) => void;
  readonly iconClassName?: string | undefined;
  readonly className?: string;
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

/** The base branch, in the warning tone when the pull request has fallen behind it. */
export function PullRequestBaseBranch({
  baseBranch,
  stacked,
  behind,
}: {
  readonly baseBranch: string;
  readonly stacked: boolean;
  readonly behind: boolean;
}) {
  const gt = useGT();
  return (
    <SharedTooltipTrigger
      render={
        <span
          className={cn(
            "inline-flex min-w-0 shrink-0 items-center gap-1",
            behind && "text-warning-foreground",
          )}
        />
      }
      label={stacked ? gt("Stacked on {baseBranch}", { baseBranch }) : baseBranch}
    >
      {stacked ? (
        <PullRequestGlyph.stack
          aria-label={gt("Stacked pull request")}
          className="size-3 shrink-0"
        />
      ) : null}
      <code className="flex min-w-0">
        <MiddleTruncate value={baseBranch} showTitle={false} />
      </code>
    </SharedTooltipTrigger>
  );
}
