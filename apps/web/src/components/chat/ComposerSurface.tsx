import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

/** Notices and the context row share the composer tray. */
function Shell({
  contextRow = false,
  className,
  ...props
}: ComponentProps<"div"> & { contextRow?: boolean }) {
  return (
    <div
      data-slot="composer-shell"
      data-context-row={contextRow || undefined}
      className={cn(
        "@container/composer-surface group/composer-surface relative isolate mx-auto flex w-full max-w-(--chat-content-max-width) flex-col rounded-2xl surface-tray",
        "[--chat-composer-surface:var(--popover)] [--chat-composer-outline:var(--tray-stroke)]",
        className,
      )}
      {...props}
    />
  );
}

function Host({ className, ...props }: ComponentProps<"div">) {
  return (
    <div data-slot="composer-host" className={cn("relative z-10 w-full", className)} {...props} />
  );
}

/** The message surface keeps its 14px corners inside the tray. */
function Main({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-chat-composer-main-surface="true"
      className={cn(
        "group relative z-10 rounded-pane surface-composer",
        className,
      )}
      {...props}
    />
  );
}

/** A plain row under the card (environment, worktree, branch) with no surface of its own. */
function ContextStrip({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-tray-row"
      // 8px on the right, so a trailing chip's hover fill ends on the send pill's edge.
      className={cn(
        "group/composer-context relative flex min-h-7.5 min-w-0 items-center gap-1 ps-1.5 pe-2 py-1 text-meta text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export const ComposerSurface = { Shell, Host, Main, ContextStrip };
