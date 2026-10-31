import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { ChevronDownIcon, XIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";

export type ComposerBannerVariant = "default" | "error" | "info" | "success" | "warning";

const variantColors: Record<ComposerBannerVariant, string> = {
  default: "[--surface-tint:var(--muted-foreground)]",
  error: "[--surface-tint:var(--error-foreground)]",
  info: "[--surface-tint:var(--update-foreground)]",
  success: "[--surface-tint:var(--success-foreground)]",
  warning: "[--surface-tint:var(--warning-foreground)]",
};

/**
 * A status line section inside the composer tray. Lines paint nothing of their
 * own: the tray is their surface. Floating layers (the command and stash menus)
 * pick an opaque surface instead.
 */
function Surface({
  surface = "tint",
  variant = "default",
  detached = false,
  className,
  ...props
}: ComponentProps<"div"> & {
  variant?: ComposerBannerVariant;
  detached?: boolean;
  surface?: "tint" | "popover" | "panel" | "card";
}) {
  const resolvedSurface = detached && surface === "tint" ? "card" : surface;
  return (
    <div
      data-composer-banner-surface={detached ? "detached" : "attached"}
      data-variant={variant}
      className={cn(
        "relative isolate border-0 shadow-none",
        variantColors[variant],
        resolvedSurface !== "tint" &&
          "rounded-card before:pointer-events-none before:absolute! before:inset-0 before:-z-1 before:rounded-card",
        resolvedSurface === "popover"
          ? "bg-transparent before:surface-popover"
          : resolvedSurface === "panel"
            ? "before:surface-panel"
            : resolvedSurface === "card"
              ? "before:surface-card"
              : null,
        className,
      )}
      {...props}
    />
  );
}

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

/** The status region above the composer. Empty regions take no space. */
function Dock({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-status-region"
      className={cn(
        "flex w-full min-w-0 flex-col not-has-data-[composer-banner-surface=attached]:hidden",
        className,
      )}
      {...props}
    />
  );
}

function Column({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex min-w-0 flex-1 flex-col empty:hidden", className)} {...props} />;
}

function Root({
  className,
  density = "default",
  variant = "default",
  width = "fill",
  surface = "tint",
  ...props
}: ComponentProps<typeof Surface> & {
  density?: "default" | "comfortable" | "spacious";
  width?: "fill" | "content";
  surface?: "tint" | "popover" | "panel" | "card";
}) {
  // The icon starts on the composer's text line and actions end on the send pill's edge.
  return (
    <Surface
      className={cn(
        "min-w-0 ps-3.5 pe-2 py-(--composer-banner-padding-block) text-xs/4 font-medium [--composer-banner-icon-column:--spacing(3)] [--composer-banner-padding-block:--spacing(2.5)]",
        density === "comfortable" && "[--composer-banner-padding-block:--spacing(2.5)]",
        density === "spacious" && "[--composer-banner-padding-block:--spacing(3)]",
        width === "content" ? "w-fit max-w-full flex-none" : "@container",
        // A corner button nests inside the banner's radius only when the padding
        // is tight; spacious padding already leaves the default radius concentric.
        density !== "spacious" && [
          "[&>[data-composer-banner-row]:first-child>[data-slot=composer-banner-actions]>[data-slot=button]:last-child]:rounded-se-xl",
          "[&>[data-composer-banner-row]:first-child>[data-slot=composer-banner-actions]>:last-child>[data-slot=button]:last-of-type]:rounded-se-xl",
          "[&>:first-child>[data-composer-banner-row]:first-child>[data-slot=composer-banner-actions]>[data-slot=button]:last-child]:rounded-se-xl",
        ],
        className,
      )}
      data-slot="composer-banner"
      surface={surface}
      data-composer-banner-width={width}
      variant={variant}
      {...props}
    />
  );
}

function Row({
  className,
  render,
  layout = "inline",
  ...props
}: useRender.ComponentProps<"div"> & {
  layout?: "inline" | "wrap-actions" | "approval";
}) {
  const rowProps = {
    className: cn(
      "group/banner-row grid min-h-4 w-full min-w-0 grid-cols-[var(--composer-banner-icon-column)_minmax(0,1fr)_auto] items-center gap-x-2 text-start",
      "not-has-[>[data-slot=composer-banner-actions]]:grid-cols-[var(--composer-banner-icon-column)_minmax(0,1fr)]",
      "[&:is(button)]:cursor-pointer [&:is(button)]:rounded-xl [&:is(button)]:hover:bg-foreground/5 [&:is(button)]:focus-visible:outline-2 [&:is(button)]:focus-visible:-outline-offset-2 [&:is(button)]:focus-visible:outline-ring",
      layout === "wrap-actions" &&
        "flex flex-wrap *:data-[slot=composer-banner-content]:max-w-[calc(100%-var(--composer-banner-icon-column)-var(--spacing))] *:data-[slot=composer-banner-content]:grow",
      layout === "approval" && "items-start gap-x-2 gap-y-3",
      className,
    ),
    "data-composer-banner-row": "true",
    "data-composer-banner-layout": layout,
  };
  return useRender({
    defaultTagName: "div",
    render,
    props: mergeProps<"div">(rowProps, props),
  });
}

function Icon({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      aria-hidden
      data-slot="composer-banner-icon"
      className={cn(
        "col-start-1 row-start-1 flex w-(--composer-banner-icon-column) min-w-0 flex-none items-center justify-center text-(--surface-tint) [&>svg]:size-3",
        "group-data-[composer-banner-layout=approval]/banner-row:pt-0.5 group-data-[composer-banner-layout=approval]/banner-row:text-warning-foreground group-data-[composer-banner-layout=approval]/banner-row:[&>svg]:size-[13px]",
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
        "col-start-2 row-start-1 flex min-w-0 items-center gap-2 *:data-[slot=composer-banner-separator]:mx-0",
        "@max-[560px]:group-data-[composer-banner-layout=approval]/banner-row:col-end-4",
        "group-not-has-[>[data-slot=composer-banner-icon]]/banner-row:col-[1/3]",
        className,
      )}
      {...props}
    />
  );
}

function Separator() {
  return (
    <span
      aria-hidden
      data-slot="composer-banner-separator"
      className="mx-1 inline-block flex-none text-muted-foreground/40"
    >
      ·
    </span>
  );
}

function Actions({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="composer-banner-actions"
      className={cn(
        "col-start-3 row-start-1 flex flex-wrap items-center justify-end gap-1.5",
        "group-data-[composer-banner-layout=approval]/banner-row:self-center @max-[560px]:group-data-[composer-banner-layout=approval]/banner-row:col-start-2 @max-[560px]:group-data-[composer-banner-layout=approval]/banner-row:col-end-4 @max-[560px]:group-data-[composer-banner-layout=approval]/banner-row:row-start-2",
        "group-data-[composer-banner-layout=wrap-actions]/banner-row:ms-auto",
        className,
      )}
      {...props}
    />
  );
}

function Children({ className, render, ...props }: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    render,
    props: mergeProps<"div">(
      { className: cn("grid gap-px pt-1.5 [&_[data-composer-banner-row]]:min-h-5.5", className) },
      props,
    ),
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

function Count({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "inline-flex flex-none justify-center font-medium text-muted-foreground tabular-nums",
        className,
      )}
      {...props}
    />
  );
}

function Body({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("min-w-0 ps-5", className)} {...props} />;
}

function Dot({ className, ...props }: ComponentProps<"span">) {
  return (
    <span className={cn("size-1.5 flex-none rounded-full bg-current", className)} {...props} />
  );
}

// Decorative: the row itself is the control. Chevron up opens the line upward.
function ToggleIcon({ expanded }: { expanded: boolean }) {
  return (
    <ChevronDownIcon
      aria-hidden
      className={cn("size-3 shrink-0 text-muted-foreground", !expanded && "rotate-180")}
    />
  );
}

function Dismiss({ className, children, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button size="icon-xs" variant="ghost-muted" className={className} {...props}>
      {children ?? <XIcon className="size-3.5" />}
    </Button>
  );
}

export const ComposerBanner = {
  Surface,
  Attachment,
  Dock,
  Column,
  Root,
  Row,
  Icon,
  Content,
  Separator,
  Actions,
  Children,
  Scroll,
  Count,
  Body,
  Dot,
  ToggleIcon,
  Dismiss,
};
