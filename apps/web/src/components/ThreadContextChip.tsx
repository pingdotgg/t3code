import type { ThreadContextRecord } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { MessagesSquareIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import {
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  CONTEXT_INLINE_CHIP_INTERACTIVE_CLASS_NAME,
  CONTEXT_INLINE_CHIP_TONE_CLASS_NAMES,
} from "./composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * Inline chip for an attached thread, in the composer and in sent messages. Prefers the
 * live title so a renamed thread never shows a stale label, and opens the thread on click.
 */
export function ThreadContextChip(props: {
  record: Pick<ThreadContextRecord, "environmentId" | "threadId" | "title">;
  className: string;
  labelClassName: string;
  copyMarkdown?: string;
}) {
  const { environmentId, threadId } = props.record;
  const shell = useThreadShell({ environmentId, threadId });
  const title = shell?.title?.trim() || props.record.title;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            to="/$environmentId/$threadId"
            params={{ environmentId, threadId }}
            aria-label={`Thread, ${title}`}
            data-markdown-copy={props.copyMarkdown}
            className={cn(
              props.className,
              CONTEXT_INLINE_CHIP_TONE_CLASS_NAMES.thread,
              CONTEXT_INLINE_CHIP_INTERACTIVE_CLASS_NAME,
              "no-underline",
            )}
          >
            <MessagesSquareIcon className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME} />
            <span className={props.labelClassName}>{title}</span>
          </Link>
        }
      />
      <TooltipPopup side="top">{shell ? "Open thread" : "Thread no longer available"}</TooltipPopup>
    </Tooltip>
  );
}
