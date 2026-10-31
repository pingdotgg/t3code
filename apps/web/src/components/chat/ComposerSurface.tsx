import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

/** One composer surface until a top attachment needs the composer to cover its overlap. */
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
        "@container/composer-surface group/composer-surface relative isolate mx-auto w-full max-w-(--chat-content-max-width)",
        "[--chat-composer-drawer-inset:1.375rem] [--chat-composer-surface:var(--popover)] [--chat-composer-glass-surface:var(--popover)] [--chat-composer-outline:var(--tray-stroke)]",
        "before:pointer-events-none before:absolute before:inset-0 before:z-0 before:rounded-pane before:surface-composer before:shadow-none!",
        "has-data-[composer-banner-surface=attached]:before:hidden data-context-row:before:hidden",
        className,
      )}
      {...props}
    />
  );
}

function Host({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-host"
      className={cn(
        "relative z-10 w-full rounded-pane shadow-(--composer-shadow) group-data-context-row/composer-surface:surface-composer",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:shadow-none group-has-data-[composer-banner-surface=attached]/composer-surface:before:hidden",
        className,
      )}
      {...props}
    />
  );
}

function Main({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-chat-composer-main-surface="true"
      className={cn(
        "group relative z-10 rounded-pane p-px",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:surface-composer",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:**:data-[chat-composer-mobile-collapsed=true]:min-h-[calc(1rem+1px)]",
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
      data-slot="composer-context-strip"
      className={cn(
        "group/composer-context relative flex w-full items-center gap-2 overflow-x-clip px-2 pt-2 text-dim-foreground",
        className,
      )}
      {...props}
    />
  );
}

export const ComposerSurface = { Shell, Host, Main, ContextStrip };
