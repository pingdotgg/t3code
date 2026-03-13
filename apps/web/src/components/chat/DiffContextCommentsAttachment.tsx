import type { ReactNode } from "react";
import { MessageSquareIcon } from "lucide-react";

import { cn } from "~/lib/utils";

interface DiffContextCommentsAttachmentProps {
  commentCount: number;
  previewTitle?: string | null;
  className?: string;
  action?: ReactNode;
}

export function DiffContextCommentsAttachment(props: DiffContextCommentsAttachmentProps) {
  const { commentCount, previewTitle, className, action } = props;

  if (commentCount <= 0) {
    return null;
  }

  const commentCountLabel = `${commentCount} comment${commentCount === 1 ? "" : "s"}`;

  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 rounded-lg border border-border/70 bg-card/90 px-2.5 py-1.5 text-foreground shadow-xs",
        className,
      )}
      title={previewTitle ?? undefined}
    >
      <span className="inline-flex size-6 items-center justify-center rounded-md bg-background/70 text-muted-foreground">
        <MessageSquareIcon className="size-3.5" />
      </span>
      <span className="text-xs font-medium">{commentCountLabel}</span>
      {action ? <span className="flex items-center">{action}</span> : null}
    </div>
  );
}
