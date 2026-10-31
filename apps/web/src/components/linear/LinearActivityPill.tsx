import { CheckIcon, MessageSquareIcon, XIcon } from "lucide-react";

import { cn } from "~/lib/utils";

import type { LinearActivityPill as Pill } from "@t3tools/client-runtime/linear/activity";

const KIND_CLASS: Record<Pill["kind"], string> = {
  "pipeline-failed": "border-destructive/35 bg-destructive/8 text-destructive-foreground",
  "pipeline-running": "border-info/35 bg-info/9 text-info-foreground",
  "pr-opened": "border-success/30 bg-success/8 text-success-foreground",
  chats: "border-border bg-muted text-muted-foreground",
};

function PillGlyph({ kind }: { kind: Pill["kind"] }) {
  switch (kind) {
    case "pipeline-failed":
      return <XIcon aria-hidden className="size-3" />;
    case "pipeline-running":
      return <span aria-hidden className="size-1.5 rounded-full bg-current" />;
    case "pr-opened":
      return <CheckIcon aria-hidden className="size-3" />;
    case "chats":
      return <MessageSquareIcon aria-hidden className="size-3" />;
  }
}

/** The one T3 activity pill an issue row shows (see `pickActivityPill` for precedence). */
export function LinearActivityPill({ pill }: { pill: Pill }) {
  return (
    <span
      data-testid="linear-activity-pill"
      data-kind={pill.kind}
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full border px-1.5 text-2xs font-medium",
        KIND_CLASS[pill.kind],
      )}
    >
      <b className="text-3xs font-bold tracking-wide opacity-85">T3</b>
      <PillGlyph kind={pill.kind} />
      {pill.label}
      {pill.chatCount > 0 ? (
        <>
          <span aria-hidden className="h-3 w-px bg-current opacity-30" />
          <MessageSquareIcon aria-hidden className="size-3" />
          {pill.chatCount}
        </>
      ) : null}
    </span>
  );
}
