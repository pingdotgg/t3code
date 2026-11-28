import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { ChevronDownIcon, XIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";

export type ComposerBannerVariant = "default" | "error" | "info" | "success" | "warning";

// The muted text token, not raw --muted-foreground: surface styles lift the detail's dim token.
const variantColors: Record<ComposerBannerVariant, string> = {
  default: "[--composer-banner-tint:var(--contrast-muted-foreground)]",
  error: "[--composer-banner-tint:var(--error-foreground)]",
  info: "[--composer-banner-tint:var(--update-foreground)]",
  success: "[--composer-banner-tint:var(--success-foreground)]",
  warning: "[--composer-banner-tint:var(--warning-foreground)]",
};

/** A row's title: the row's tint tells it apart from the detail, never size or weight. */
export const composerBannerTitleClassName = "min-w-0 truncate text-(--composer-banner-tint)";
export const composerBannerDetailClassName =
  "w-0 min-w-0 grow truncate text-dim-foreground [&_[data-slot=inline-button]]:inline-block [&_[data-slot=inline-button]]:max-w-full [&_[data-slot=inline-button]]:truncate [&_[data-slot=inline-button]]:align-bottom [&_[data-slot=inline-button]:not(:hover)]:text-inherit";

/** One section of the tray's status region. */
function Attachment({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-banner-attachment"
      className={cn("w-full min-w-0", className)}
      {...props}
    />
  );
}

/** A section of rows above the composer. Empty sections take no space. */
function Dock({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-status-region"
      data-composer-stack-section
      className={cn(
        "surface-composer-banner flex w-full min-w-0 flex-col py-1 not-has-data-[composer-banner-surface=attached]:hidden",
        className,
      )}
      {...props}
    />
  );
}

/**
 * One line above the composer: a 28px row, the icon on the composer's text line, the text on
 * the text column and controls ending where the queue's do. Lines paint nothing of their own:
 * the tray is their surface. A detached line (a popover, a pane without a tray) is a card.
 */
function Root({
  className,
  variant = "default",
  detached = false,
  ...props
}: ComponentProps<"div"> & { variant?: ComposerBannerVariant; detached?: boolean }) {
  return (
    <div
      data-slot="composer-banner"
      data-composer-banner-surface={detached ? "detached" : "attached"}
      data-variant={variant}
      className={cn(
        "@container relative isolate min-w-0 ps-3.5 pe-2 text-meta sm:pe-2.25",
        variantColors[variant],
        detached &&
          "rounded-card py-1 before:pointer-events-none before:absolute! before:inset-0 before:-z-1 before:rounded-card before:surface-card",
        className,
      )}
      {...props}
    />
  );
}

function Row({ className, render, ...props }: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    render,
    props: mergeProps<"div">(
      {
        // Narrow rows wrap their actions under the text, right-aligned.
        className: cn(
          "flex min-h-7 w-full min-w-0 flex-wrap items-center gap-x-1.5 text-start",
          className,
        ),
      },
      props,
    ),
  });
}

function Icon({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      aria-hidden
      data-slot="composer-banner-icon"
      className={cn(
        "flex w-3.5 flex-none items-center justify-center text-(--composer-banner-tint) [&>svg]:size-3.5 max-sm:w-4 max-sm:[&>svg]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function Content({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="composer-banner-content"
      className={cn(
        // The end margin leaves the controls' own gap between the text and the first control.
        "-me-1 flex min-w-0 max-w-[calc(100%-var(--spacing)*5)] grow basis-0 items-center gap-1.5",
        className,
      )}
      {...props}
    />
  );
}

function Actions({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="composer-banner-actions"
      className={cn("ms-auto flex flex-none items-center justify-end gap-0.5", className)}
      {...props}
    />
  );
}

/** Lines under the row, such as usage meters, starting on the row's text column. */
function Children({ className, render, ...props }: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    render,
    props: mergeProps<"div">({ className: cn("min-w-0 ps-5 pb-1", className) }, props),
  });
}

function Scroll({ className, children, ...props }: ComponentProps<typeof ScrollArea>) {
  return (
    <ScrollArea
      radius="none"
      scrollFade
      className={cn("h-auto max-h-[min(24rem,40dvh)]", className)}
      {...props}
    >
      {}
      <div className="[[data-has-overflow-y]>&]:pe-2">{children}</div>
    </ScrollArea>
  );
}

// Decorative: the row itself is the control. Chevron up opens the line upward.
function ToggleIcon({ expanded }: { expanded: boolean }) {
  return (
    <ChevronDownIcon
      aria-hidden
      className={cn(
        // Last in its row, its ink ends where a dismiss's does.
        "size-3 shrink-0 text-muted-foreground last:me-1.5",
        !expanded && "rotate-180",
      )}
    />
  );
}

function Dismiss({ children, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button size="icon-xs" variant="ghost-muted" {...props}>
      {children ?? <XIcon />}
    </Button>
  );
}

export const ComposerBanner = {
  Attachment,
  Dock,
  Root,
  Row,
  Icon,
  Content,
  Actions,
  Children,
  Scroll,
  ToggleIcon,
  Dismiss,
};
