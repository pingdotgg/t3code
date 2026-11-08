import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

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
        "[--chat-composer-drawer-inset:1.375rem] [--chat-composer-glass-surface:var(--card)] [--chat-composer-outline:rgb(0_0_0/8%)]",
        "dark:[--chat-composer-glass-surface:var(--surface-raised)] dark:[--chat-composer-highlight:rgb(255_255_255/3%)] dark:[--chat-composer-outline:color-mix(in_srgb,var(--color-white)_5%,transparent)]",
        "[html[data-theme-id]_&]:[--chat-composer-glass-surface:var(--app-theme-surface-raised)] [html[data-theme-id]_&]:[--chat-composer-outline:var(--app-theme-toolbar-border)]",
        "dark:[html[data-theme-id]:not([data-theme-id=t3-chat])_&]:[--chat-composer-highlight:color-mix(in_srgb,var(--app-theme-input)_12%,transparent)] dark:[html[data-theme-id]:not([data-theme-id=t3-chat])_&]:[--chat-composer-outline:color-mix(in_srgb,var(--app-theme-input)_30%,var(--background))]",
        "dark:[html[data-theme-id=t3-chat]_&]:[--chat-composer-highlight:color-mix(in_srgb,#432d48_12%,transparent)] dark:[html[data-theme-id=t3-chat]_&]:[--chat-composer-outline:#241e28]",
        "before:pointer-events-none before:absolute before:inset-0 before:z-0 before:rounded-2xl before:bg-(--chat-composer-glass-surface)/(--glass-opacity) before:backdrop-blur-(--glass-blur) before:backdrop-saturate-(--glass-saturation)",
        "not-supports-[((backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px)))]:before:bg-(--chat-composer-glass-surface)",
        "has-data-[composer-banner-surface=attached]:before:hidden",
        // As in monocode, the context row shares the card's glass and outline below a divider.
        "data-context-row:after:pointer-events-none data-context-row:after:absolute data-context-row:after:inset-0 data-context-row:after:z-20 data-context-row:after:rounded-2xl data-context-row:after:border data-context-row:after:border-(--chat-composer-outline)",
        className,
      )}
      {...props}
    />
  );
}

const outlineClasses =
  "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:border after:border-(--chat-composer-outline) dark:after:inset-shadow-2xs dark:after:inset-shadow-(color:--chat-composer-highlight)";

function Host({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-host"
      className={cn(
        "relative z-10 w-full rounded-2xl shadow-composer after:z-1 dark:shadow-none",
        outlineClasses,
        "group-data-context-row/composer-surface:after:hidden",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:shadow-none group-has-data-[composer-banner-surface=attached]/composer-surface:before:hidden group-has-data-[composer-banner-surface=attached]/composer-surface:after:hidden",
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
        "group relative z-10 rounded-2xl p-px",
        outlineClasses,
        "after:z-20 after:hidden group-has-data-[composer-banner-surface=attached]/composer-surface:after:block",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:bg-(--chat-composer-glass-surface)/(--glass-opacity) group-has-data-[composer-banner-surface=attached]/composer-surface:backdrop-blur-(--glass-blur) group-has-data-[composer-banner-surface=attached]/composer-surface:backdrop-saturate-(--glass-saturation)",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:shadow-composer dark:group-has-data-[composer-banner-surface=attached]/composer-surface:shadow-none",
        "not-supports-[((backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px)))]:group-has-data-[composer-banner-surface=attached]/composer-surface:bg-(--chat-composer-glass-surface)",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:**:data-[chat-composer-mobile-collapsed=true]:min-h-[calc(1rem+1px)]",
        className,
      )}
      {...props}
    />
  );
}

/** The row under the input (environment, worktree, branch), inside the card below a divider. */
function ContextStrip({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-context-strip"
      className={cn(
        "group/composer-context relative flex w-full items-center gap-2 overflow-x-clip border-t border-(--chat-composer-outline) px-3 py-2 text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export const ComposerSurface = { Shell, Host, Main, ContextStrip };
