import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

function Shell({
  contextStrip = false,
  className,
  ...props
}: ComponentProps<"div"> & { contextStrip?: boolean }) {
  return (
    <div
      data-slot="composer-shell"
      data-with-context={contextStrip || undefined}
      className={cn(
        "@container/composer-surface group/composer-surface relative isolate mx-auto w-full max-w-(--chat-content-max-width)",
        "[--chat-composer-drawer-inset:1.375rem] [--chat-composer-glass-surface:var(--card)] [--chat-composer-outline:rgb(0_0_0/8%)]",
        "dark:[--chat-composer-glass-surface:var(--surface-raised)] dark:[--chat-composer-highlight:rgb(255_255_255/3%)] dark:[--chat-composer-outline:color-mix(in_srgb,var(--color-white)_5%,transparent)]",
        "[html[data-theme-id]_&]:[--chat-composer-glass-surface:var(--app-theme-surface-raised)] [html[data-theme-id]_&]:[--chat-composer-outline:var(--app-theme-toolbar-border)]",
        "dark:[html[data-theme-id]:not([data-theme-id=t3-chat])_&]:[--chat-composer-highlight:color-mix(in_srgb,var(--app-theme-input)_12%,transparent)] dark:[html[data-theme-id]:not([data-theme-id=t3-chat])_&]:[--chat-composer-outline:color-mix(in_srgb,var(--app-theme-input)_30%,var(--background))]",
        "dark:[html[data-theme-id=t3-chat]_&]:[--chat-composer-highlight:color-mix(in_srgb,#432d48_12%,transparent)] dark:[html[data-theme-id=t3-chat]_&]:[--chat-composer-outline:#241e28]",
        "before:pointer-events-none before:absolute before:inset-0 before:z-0 before:rounded-2xl before:bg-(--chat-composer-glass-surface)/(--glass-opacity) before:backdrop-blur-(--glass-blur) before:backdrop-saturate-(--glass-saturation)",
        "not-supports-[((backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px)))]:before:bg-(--chat-composer-glass-surface)",
        "has-data-[composer-banner-surface=attached]:before:hidden data-model-strip-transition:before:hidden",
        contextStrip && [
          "[--chat-composer-context-extension:2.25rem] sm:[--chat-composer-context-extension:2rem]",
          "supports-[clip-path:shape(from_0_0,line_to_1px_1px)]:before:rounded-none",
          "before:[clip-path:shape(from_0_16px,curve_to_16px_0_with_0_7.16px/7.16px_0,line_to_calc(100%-16px)_0,curve_to_100%_16px_with_calc(100%-7.16px)_0/100%_7.16px,line_to_100%_calc(100%-var(--chat-composer-context-extension)-16px),curve_to_calc(100%-16px)_calc(100%-var(--chat-composer-context-extension))_with_100%_calc(100%-var(--chat-composer-context-extension)-7.16px)/calc(100%-7.16px)_calc(100%-var(--chat-composer-context-extension)),line_to_calc(100%-var(--chat-composer-drawer-inset))_calc(100%-var(--chat-composer-context-extension)),line_to_calc(100%-var(--chat-composer-drawer-inset))_calc(100%-16px),curve_to_calc(100%-var(--chat-composer-drawer-inset)-16px)_100%_with_calc(100%-var(--chat-composer-drawer-inset))_calc(100%-7.16px)/calc(100%-var(--chat-composer-drawer-inset)-7.16px)_100%,line_to_calc(var(--chat-composer-drawer-inset)+16px)_100%,curve_to_var(--chat-composer-drawer-inset)_calc(100%-16px)_with_calc(var(--chat-composer-drawer-inset)+7.16px)_100%/var(--chat-composer-drawer-inset)_calc(100%-7.16px),line_to_var(--chat-composer-drawer-inset)_calc(100%-var(--chat-composer-context-extension)),line_to_16px_calc(100%-var(--chat-composer-context-extension)),curve_to_0_calc(100%-var(--chat-composer-context-extension)-16px)_with_7.16px_calc(100%-var(--chat-composer-context-extension))/0_calc(100%-var(--chat-composer-context-extension)-7.16px),line_to_0_16px,close)]",
          "not-supports-[clip-path:shape(from_0_0,line_to_1px_1px)]:before:bottom-(--chat-composer-context-extension)",
        ],
        className,
      )}
      {...props}
    />
  );
}

const outlineClasses =
  "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:border after:border-(--chat-composer-outline) dark:after:inset-shadow-2xs dark:after:inset-shadow-(color:--chat-composer-highlight)";

const contextSeamClasses =
  "group-data-with-context/composer-surface:after:[clip-path:polygon(0_0,100%_0,100%_100%,calc(100%-22px)_100%,calc(100%-22px)_calc(100%-2px),22px_calc(100%-2px),22px_100%,0_100%)]";

function Host({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-host"
      className={cn(
        "relative z-10 w-full rounded-2xl shadow-composer after:z-1 dark:shadow-none",
        outlineClasses,
        contextSeamClasses,
        "group-has-data-[composer-banner-surface=attached]/composer-surface:shadow-none group-has-data-[composer-banner-surface=attached]/composer-surface:after:hidden",
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
        "group-data-model-strip-transition/composer-surface:bg-(--chat-composer-glass-surface)/(--glass-opacity) group-data-model-strip-transition/composer-surface:backdrop-blur-(--glass-blur) group-data-model-strip-transition/composer-surface:backdrop-saturate-(--glass-saturation)",
        outlineClasses,
        contextSeamClasses,
        "after:z-20 after:hidden group-has-data-[composer-banner-surface=attached]/composer-surface:after:block group-data-model-strip-transition/composer-surface:after:block",
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

// Position hints keep class merging from dropping mask color stops.
// Dark goes transparent only where the Shell backdrop paints the strip; scoping it keeps dark: from beating the fills below.
function ContextStrip({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-context-strip"
      className={cn(
        "group/composer-context relative isolate mx-auto -mt-4 flex w-[calc(100%-2*var(--chat-composer-drawer-inset))] items-center gap-2 overflow-x-clip overflow-y-visible px-2 pt-5 pb-1",
        "before:absolute before:inset-0 before:-z-1 before:rounded-b-2xl before:border before:border-(--chat-composer-outline) before:mask-b-from-transparent before:mask-b-from-(position:--spacing-composer-seam) before:mask-b-to-black before:mask-b-to-(position:--spacing-composer-seam)",
        "before:bg-(--chat-composer-glass-surface) dark:before:bg-composer-seam-below dark:before:bg-origin-border",
        "dark:supports-[clip-path:shape(from_0_0,line_to_1px_1px)]:group-not-has-data-[composer-banner-surface=attached]/composer-surface:before:bg-transparent",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:before:bg-(--chat-composer-glass-surface)/(--glass-opacity) group-has-data-[composer-banner-surface=attached]/composer-surface:before:backdrop-blur-(--glass-blur) group-has-data-[composer-banner-surface=attached]/composer-surface:before:backdrop-saturate-(--glass-saturation)",
        "not-supports-[clip-path:shape(from_0_0,line_to_1px_1px)]:before:bg-(--chat-composer-glass-surface)/(--glass-opacity) not-supports-[clip-path:shape(from_0_0,line_to_1px_1px)]:before:backdrop-blur-(--glass-blur) not-supports-[clip-path:shape(from_0_0,line_to_1px_1px)]:before:backdrop-saturate-(--glass-saturation)",
        className,
      )}
      {...props}
    />
  );
}

export const ComposerSurface = { Shell, Host, Main, ContextStrip };
