import type { LucideIcon } from "lucide-react";

import { cn } from "~/lib/utils";

export function TimelineSystemDivider(props: {
  readonly label: string;
  readonly detail?: string | null;
  readonly tone?: "neutral" | "danger";
  readonly icon?: LucideIcon;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}) {
  const Icon = props.icon;
  const content = (
    <>
      {Icon ? <Icon className="size-3 shrink-0" /> : null}
      <span className="font-medium">{props.label}</span>
      {props.detail ? <span className="max-w-80 truncate opacity-70">· {props.detail}</span> : null}
    </>
  );

  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 py-2 text-[11px] text-muted-foreground",
        props.tone === "danger" && "text-destructive",
      )}
    >
      <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
      {props.onAction ? (
        <button
          type="button"
          aria-label={props.actionLabel}
          onClick={props.onAction}
          className="flex min-w-0 items-center gap-1.5 rounded-full border border-border/70 bg-background px-2.5 py-1 transition-colors hover:bg-muted"
          title={props.actionLabel}
        >
          {content}
        </button>
      ) : (
        <span className="flex min-w-0 items-center gap-1.5 rounded-full px-2 py-1">{content}</span>
      )}
      <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
    </div>
  );
}
