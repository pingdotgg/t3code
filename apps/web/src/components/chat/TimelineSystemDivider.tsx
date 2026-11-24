import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { InlineButton } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { WorkLogRow, WorkLogTarget, WorkLogVerb } from "./WorkLog";

/**
 * `turn` ends a turn (a run interrupted) and reads as one of its work rows. `divider` marks
 * where the conversation's context changes (a fork, a new session, a handoff), drawn like
 * the compaction divider.
 */
export function TimelineSystemDivider(props: {
  readonly label: string;
  readonly detail?: ReactNode | null;
  readonly tone?: "neutral" | "danger";
  readonly icon?: LucideIcon;
  readonly wrapDetail?: boolean;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  readonly placement?: "turn" | "divider";
}) {
  const Icon = props.icon;
  const danger = props.tone === "danger";

  if (props.placement === "turn") {
    return (
      <WorkLogRow
        wrapLabel={props.wrapDetail === true}
        icon={
          Icon ? (
            <Icon
              aria-hidden
              className={cn(
                "size-3.5 shrink-0 stroke-2",
                danger ? "text-error-foreground" : "text-dim-foreground",
              )}
            />
          ) : undefined
        }
        label={
          props.wrapDetail ? (
            <span className="wrap-anywhere">
              <WorkLogVerb tone={danger ? "error" : "muted"}>{props.label}</WorkLogVerb>
              {props.detail ? (
                <>
                  {" "}
                  <span className="text-body whitespace-pre-wrap text-dim-foreground">
                    {props.detail}
                  </span>
                </>
              ) : null}
            </span>
          ) : (
            <span className="flex min-w-0 items-baseline gap-1.25">
              <WorkLogVerb tone={danger ? "error" : "muted"}>{props.label}</WorkLogVerb>
              {props.detail ? <WorkLogTarget>{props.detail}</WorkLogTarget> : null}
            </span>
          )
        }
        trailing={
          props.onAction ? (
            <InlineButton onClick={props.onAction}>{props.actionLabel}</InlineButton>
          ) : null
        }
      />
    );
  }

  const content = (
    <>
      <span
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5",
          danger && "text-error-foreground",
        )}
      >
        {Icon ? <Icon aria-hidden className="size-3 shrink-0" /> : null}
        {props.label}
      </span>
      {props.detail ? (
        <span
          className={cn(
            "min-w-0 text-dim-foreground",
            props.wrapDetail ? "wrap-anywhere whitespace-pre-wrap" : "inline-flex items-center",
            !props.wrapDetail && typeof props.detail === "string" && "max-w-80 truncate",
          )}
        >
          {props.detail}
        </span>
      ) : null}
    </>
  );
  const rule = cn("h-px flex-1", danger ? "surface-divider-rule-danger" : "surface-divider-rule");

  return (
    <div className="flex min-w-0 items-center gap-3 py-2 text-meta text-muted-foreground">
      <span aria-hidden="true" className={rule} />
      {props.onAction ? (
        <SystemRowAction {...props}>
          <span className="flex min-w-0 flex-wrap items-center justify-center gap-x-1.5 text-center">
            {content}
          </span>
        </SystemRowAction>
      ) : (
        <span className="flex min-w-0 flex-wrap items-center justify-center gap-x-1.5 text-center">
          {content}
        </span>
      )}
      <span aria-hidden="true" className={rule} />
    </div>
  );
}

function SystemRowAction(props: {
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={props.actionLabel}
            onClick={props.onAction}
            className="min-w-0 cursor-pointer rounded-control px-1.5 py-0.5 transition-colors hover:surface-ghost-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.actionLabel}</TooltipPopup>
    </Tooltip>
  );
}
