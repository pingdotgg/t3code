import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

export function TimelineSystemDivider(props: {
  readonly label: string;
  readonly detail?: ReactNode | null;
  readonly tone?: "neutral" | "danger";
  readonly icon?: LucideIcon;
  readonly showDetailSeparator?: boolean;
  readonly wrapDetail?: boolean;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}) {
  const Icon = props.icon;
  const wrapsDetail = props.wrapDetail === true && typeof props.detail === "string";
  const labelRef = useRef<HTMLSpanElement>(null);
  const detailRef = useRef<HTMLSpanElement>(null);
  const [detailWrapped, setDetailWrapped] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads layout to tell whether flex-wrap moved the detail below the label
  useLayoutEffect(() => {
    const label = labelRef.current;
    const detail = detailRef.current;
    const pill = detail?.parentElement;
    if (!wrapsDetail || !label || !detail || !pill) return;
    const update = () => setDetailWrapped(detail.offsetTop >= label.offsetTop + label.offsetHeight);
    update();
    return observeResize([pill, detail], update);
  }, [wrapsDetail]);

  const separator = props.showDetailSeparator !== false;
  const content = (
    <>
      {Icon ? <Icon className="size-3 shrink-0" /> : null}
      <span ref={labelRef} className="font-medium">
        {props.label}
      </span>
      {props.detail ? (
        <span
          ref={detailRef}
          className={cn(
            "inline-flex min-w-0 items-center opacity-70",
            typeof props.detail === "string" && !props.wrapDetail && "max-w-80 truncate",
            wrapsDetail && "relative whitespace-pre-wrap text-center",
            // The dot takes no width, so hiding it cannot change whether the detail fits inline.
            wrapsDetail &&
              separator &&
              "mx-1.5 before:absolute before:right-full before:mr-1 before:content-['·']",
            wrapsDetail && detailWrapped && "before:hidden",
          )}
        >
          {separator && !wrapsDetail ? "·\u00a0" : null}
          {props.detail}
        </span>
      ) : null}
    </>
  );

  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 py-2 text-2xs text-muted-foreground",
        props.tone === "danger" && "text-destructive",
      )}
    >
      <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
      {props.onAction ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={props.actionLabel}
                onClick={props.onAction}
                className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-full border border-border/70 bg-background px-2.5 py-1 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
              />
            }
          >
            {content}
          </TooltipTrigger>
          <TooltipPopup side="top">{props.actionLabel}</TooltipPopup>
        </Tooltip>
      ) : (
        <span className="flex min-w-0 flex-wrap items-center justify-center gap-1.5 rounded-full px-2 py-1">
          {content}
        </span>
      )}
      <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
    </div>
  );
}
