import type { PullRequestUpdateMethod } from "@t3tools/contracts";
import { ChevronDownIcon, TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { MiddleTruncate } from "../ui/middle-truncate";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestGlyph } from "./pullRequestIcons";

interface BaseFreshness {
  readonly behindBy: number | null;
  readonly methods: ReadonlyArray<PullRequestUpdateMethod>;
}

function pullRequestUpdateMethodLabel(method: PullRequestUpdateMethod): string {
  return method === "rebase" ? "Update with rebase" : "Update with merge commit";
}

function PullRequestBaseUpdateAction({
  methods,
  pending,
  onUpdate,
}: {
  readonly methods: ReadonlyArray<PullRequestUpdateMethod>;
  readonly pending: boolean;
  readonly onUpdate: (method: PullRequestUpdateMethod) => void;
}) {
  if (methods.length === 0) return null;
  const only = methods.length === 1 ? methods[0] : undefined;
  if (only !== undefined) {
    const label = pullRequestUpdateMethodLabel(only);
    return (
      <Button
        size="xs"
        variant="outline"
        disabled={pending}
        aria-label={label}
        title={label}
        onClick={() => onUpdate(only)}
      >
        <PullRequestGlyph.merged aria-hidden className="size-3" />
        Update
      </Button>
    );
  }
  return (
    <Menu>
      <MenuTrigger
        disabled={pending}
        render={<Button size="xs" variant="outline" aria-label="Update branch from base" />}
      >
        <PullRequestGlyph.merged aria-hidden className="size-3" />
        Update
        <ChevronDownIcon aria-hidden className="size-3 text-muted-foreground" />
      </MenuTrigger>
      <MenuPopup align="start" side="bottom">
        {methods.map((method) => (
          <MenuItem key={method} disabled={pending} onClick={() => onUpdate(method)}>
            <PullRequestGlyph.merged aria-hidden className="size-3.5" />
            {pullRequestUpdateMethodLabel(method)}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
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
      : ` by ${freshness.behindBy.toLocaleString()} ${
          freshness.behindBy === 1 ? "commit" : "commits"
        }`;
  const summary = `This branch is out-of-date with ${baseBranch}${behind}.`;
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <Popover>
        <PopoverTrigger
          openOnHover
          delay={0}
          closeDelay={120}
          render={
            <button
              type="button"
              aria-label={summary}
              className="inline-flex min-w-0 max-w-full shrink cursor-help items-center gap-1 rounded-sm text-warning-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            />
          }
        >
          {children}
          <TriangleAlertIcon aria-hidden className={cn("size-3.5 shrink-0", iconClassName)} />
        </PopoverTrigger>
        <PopoverPopup align="start" side="bottom" className="max-w-80" padding="compact">
          <p className="text-xs text-foreground">{summary}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">Changes can be cleanly merged.</p>
        </PopoverPopup>
      </Popover>
      <span className="shrink-0">
        <PullRequestBaseUpdateAction
          methods={freshness.methods}
          pending={pending}
          onUpdate={onUpdate}
        />
      </span>
    </span>
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
      <TooltipPopup side="top">{stacked ? `Stacked on ${baseBranch}` : baseBranch}</TooltipPopup>
    </Tooltip>
  );
}
