import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { ChevronDownIcon, XIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";
import { Button, buttonVariants } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";

export type ComposerBannerVariant = "default" | "error" | "info" | "success" | "warning";

const surfaceColors = cn(
  "[--chat-composer-attached-surface:var(--chat-composer-glass-surface,var(--card))]",
  "dark:[--chat-composer-attached-surface:var(--chat-composer-glass-surface,var(--surface-raised))]",
  "[html[data-theme-id]_&]:[--chat-composer-attached-surface:var(--app-theme-surface-raised)]",
);

const neutralOutline = cn(
  "[--chat-composer-attached-outline:var(--chat-composer-outline,color-mix(in_srgb,var(--contrast-foreground)_8%,transparent))]",
  "dark:[--chat-composer-attached-outline:var(--chat-composer-outline,color-mix(in_srgb,var(--color-white)_5%,transparent))]",
  "[html[data-theme-id]_&]:[--chat-composer-attached-outline:var(--chat-composer-outline,var(--app-theme-toolbar-border))]",
  "dark:[html[data-theme-id]:not([data-theme-id=t3-chat])_&]:[--chat-composer-attached-outline:var(--chat-composer-outline,color-mix(in_srgb,var(--app-theme-input)_30%,var(--background)))]",
  "dark:[html[data-theme-id=t3-chat]_&]:[--chat-composer-attached-outline:#241e28]",
);

const variantColors: Record<ComposerBannerVariant, string> = {
  default: neutralOutline,
  error:
    "[--chat-composer-attached-outline:color-mix(in_srgb,var(--error)_32%,transparent)] [--chat-composer-attached-tint:color-mix(in_srgb,var(--error)_8%,transparent)]",
  info: neutralOutline,
  success: neutralOutline,
  warning:
    "[--chat-composer-attached-outline:color-mix(in_srgb,var(--warning)_28%,transparent)] [--chat-composer-attached-tint:color-mix(in_srgb,var(--warning)_8%,transparent)]",
};

/** Shared glass and attachment seam, also used by the command menu without banner row padding. */
function Surface({
  placement = "attached",
  variant = "default",
  className,
  ...props
}: ComponentProps<"div"> & {
  placement?: "attached" | "floating";
  variant?: ComposerBannerVariant;
}) {
  return (
    <div
      data-composer-banner-surface={placement}
      data-variant={variant}
      className={cn(
        surfaceColors,
        "relative isolate border-0 bg-transparent shadow-none [--chat-composer-attached-tint:transparent]",
        variantColors[variant],
        placement === "attached"
          ? "[--chat-composer-attachment-overlap:calc(1rem+1px)] before:rounded-t-[16px]"
          : "[--chat-composer-attachment-overlap:0px] before:rounded-[1rem]",
        "before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:border before:border-(--chat-composer-attached-outline)",
        "before:bg-[color-mix(in_srgb,var(--chat-composer-attached-surface)_var(--glass-opacity),transparent)] before:bg-[linear-gradient(var(--chat-composer-attached-tint),var(--chat-composer-attached-tint))] before:backdrop-blur-(--glass-blur) before:backdrop-saturate-(--glass-saturation)",
        "before:mask-[linear-gradient(to_top,transparent_0_var(--chat-composer-attachment-overlap),black_var(--chat-composer-attachment-overlap))] before:shadow-[0_12px_28px_-18px_rgb(0_0_0/40%)] dark:before:shadow-[0_14px_32px_-18px_rgb(0_0_0/75%)]",
        "dark:supports-[(backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px))]:before:bg-[linear-gradient(var(--chat-composer-attached-tint),var(--chat-composer-attached-tint)),linear-gradient(to_top,transparent_0_var(--chat-composer-attachment-overlap),rgb(0_0_0/18%)_var(--chat-composer-attachment-overlap),transparent_calc(var(--chat-composer-attachment-overlap)+10px))]",
        "not-supports-[((backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px)))]:before:bg-(--chat-composer-attached-surface)",
        className,
      )}
      {...props}
    />
  );
}

// A peeking notice uses the first hidden notice's severity, never the attached row's.
const peekBorder: Record<ComposerBannerVariant, string> = {
  default: "border-(--chat-composer-attached-outline)",
  error: "border-destructive/24",
  info: "border-(--chat-composer-attached-outline)",
  success: "border-(--chat-composer-attached-outline)",
  warning: "border-warning/24",
};

function Peek({
  className,
  variant = "default",
  ...props
}: ComponentProps<"button"> & { variant?: ComposerBannerVariant }) {
  return (
    <button
      type="button"
      data-slot="composer-banner-peek"
      className={cn(
        surfaceColors,
        neutralOutline,
        "absolute inset-x-0 bottom-0 z-0 mx-auto h-3 w-[96%] cursor-pointer rounded-t-2xl border border-b-0 shadow-[0_6px_18px_rgb(0_0_0/6%)]",
        "bg-[color-mix(in_srgb,var(--chat-composer-attached-surface)_var(--glass-opacity),transparent)] backdrop-blur-(--glass-blur) backdrop-saturate-(--glass-saturation)",
        "not-supports-[((backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px)))]:bg-(--chat-composer-attached-surface)",
        "transition-opacity duration-150 ease-out focus-visible:outline-2 focus-visible:outline-ring",
        peekBorder[variant],
        className,
      )}
      {...props}
    />
  );
}

function Attachment({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-banner-attachment"
      className={cn(
        "mx-auto -mb-[calc(1rem+1px)] w-[calc(100%-2*var(--chat-composer-drawer-inset))]",
        // Adjacent attachments share their outline, including notices outside the form.
        "[&+[data-slot=composer-banner-attachment]_[data-composer-banner-surface=attached]]:before:rounded-none [&+[data-slot=composer-banner-attachment]_[data-composer-banner-surface=attached]]:before:border-t-0",
        "[&+:has([data-chat-composer-form])_[data-chat-composer-form]>[data-slot=composer-banner-attachment]:first-child_[data-composer-banner-surface=attached]]:before:rounded-none [&+:has([data-chat-composer-form])_[data-chat-composer-form]>[data-slot=composer-banner-attachment]:first-child_[data-composer-banner-surface=attached]]:before:border-t-0",
        className,
      )}
      {...props}
    />
  );
}

function Dock({ className, ...props }: ComponentProps<"div">) {
  return (
    <Attachment
      className={cn(
        "flex items-end gap-1 not-has-data-[composer-banner-surface=attached]:hidden",
        className,
      )}
      {...props}
    />
  );
}

/** Attachments share a column while neighboring tabs keep their own surface. */
function Column({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 flex-col empty:hidden",
        "[&>[data-slot=composer-banner-attachment]]:w-full [&>[data-slot=composer-banner-attachment]:last-child]:mb-0",
        className,
      )}
      {...props}
    />
  );
}

function Root({
  className,
  density = "default",
  placement = "attached",
  variant = "default",
  width = "fill",
  ...props
}: ComponentProps<"div"> & {
  density?: "default" | "comfortable";
  placement?: "attached" | "floating";
  variant?: ComposerBannerVariant;
  width?: "fill" | "content";
}) {
  return (
    <Surface
      className={cn(
        "min-w-0 px-1 pt-(--composer-banner-padding-block) pb-[calc(var(--chat-composer-attachment-overlap)+var(--composer-banner-padding-block))] text-xs/4 [--composer-banner-icon-column:--spacing(7)] [--composer-banner-padding-block:--spacing(1)] sm:[--composer-banner-icon-column:--spacing(6)]",
        density === "comfortable" && "[--composer-banner-padding-block:--spacing(1.25)]",
        width === "content" ? "w-fit max-w-full flex-none" : "@container",
        className,
      )}
      data-slot="composer-banner"
      placement={placement}
      data-composer-banner-width={width}
      variant={variant}
      {...props}
    />
  );
}

/** The same row can be a status, a list item, or an entire disclosure button. */
function Row({
  className,
  render,
  layout = "inline",
  ...props
}: useRender.ComponentProps<"div"> & {
  layout?: "inline" | "wrap-actions" | "wrap-actions-narrow";
}) {
  const rowProps = {
    className: cn(
      "group/banner-row grid min-h-(--composer-banner-icon-column) w-full min-w-0 grid-cols-[var(--composer-banner-icon-column)_minmax(0,1fr)_auto] items-center gap-x-1 text-start",
      "not-has-[>[data-slot=composer-banner-actions]]:grid-cols-[var(--composer-banner-icon-column)_minmax(0,1fr)]",
      "[&:is(button)]:cursor-pointer [&:is(button)]:rounded-[0.5rem] [&:is(button)]:focus-visible:outline-2 [&:is(button)]:focus-visible:-outline-offset-2 [&:is(button)]:focus-visible:outline-ring",
      layout === "wrap-actions" &&
        "@max-[400px]:*:data-[slot=composer-banner-content]:min-h-(--composer-banner-icon-column)",
      layout === "wrap-actions-narrow" &&
        "@max-[320px]:*:data-[slot=composer-banner-content]:min-h-(--composer-banner-icon-column)",
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
        "col-start-1 row-start-1 flex w-(--composer-banner-icon-column) min-w-0 flex-none items-center justify-center text-muted-foreground [&>svg]:size-3",
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
        "col-start-2 row-start-1 flex min-w-0 items-center gap-1 *:data-[slot=composer-banner-separator]:mx-0",
        "group-not-has-[>[data-slot=composer-banner-icon]]/banner-row:col-[1/3] group-not-has-[>[data-slot=composer-banner-icon]]/banner-row:ps-2 sm:group-not-has-[>[data-slot=composer-banner-icon]]/banner-row:ps-1.5",
        "group-not-has-[>[data-slot=composer-banner-icon],>[data-slot=composer-banner-actions]]/banner-row:pe-2 sm:group-not-has-[>[data-slot=composer-banner-icon],>[data-slot=composer-banner-actions]]/banner-row:pe-1.5",
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
        "col-start-3 row-start-1 flex flex-wrap items-center justify-end gap-1",
        "@max-[400px]:group-data-[composer-banner-layout=wrap-actions]/banner-row:has-[>:nth-child(2)]:col-start-2 @max-[400px]:group-data-[composer-banner-layout=wrap-actions]/banner-row:has-[>:nth-child(2)]:col-end-4 @max-[400px]:group-data-[composer-banner-layout=wrap-actions]/banner-row:has-[>:nth-child(2)]:row-start-2 @max-[400px]:group-data-[composer-banner-layout=wrap-actions]/banner-row:has-[>:nth-child(2)]:-ms-2 @max-[400px]:group-data-[composer-banner-layout=wrap-actions]/banner-row:has-[>:nth-child(2)]:justify-start",
        "@max-[320px]:group-data-[composer-banner-layout=wrap-actions-narrow]/banner-row:has-[>:nth-child(2)]:col-start-2 @max-[320px]:group-data-[composer-banner-layout=wrap-actions-narrow]/banner-row:has-[>:nth-child(2)]:col-end-4 @max-[320px]:group-data-[composer-banner-layout=wrap-actions-narrow]/banner-row:has-[>:nth-child(2)]:row-start-2 @max-[320px]:group-data-[composer-banner-layout=wrap-actions-narrow]/banner-row:has-[>:nth-child(2)]:-ms-2 @max-[320px]:group-data-[composer-banner-layout=wrap-actions-narrow]/banner-row:has-[>:nth-child(2)]:justify-start",
        className,
      )}
      {...props}
    />
  );
}

/** Child rows keep their parent's columns and begin immediately after its header. */
function Children({ className, render, ...props }: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    render,
    props: mergeProps<"div">(
      { className: cn("grid gap-px [&_[data-composer-banner-row]]:min-h-5", className) },
      props,
    ),
  });
}

/** Bounded banner content uses the app's scroll area and fades only overflowing edges. */
function Scroll({ className, ...props }: ComponentProps<typeof ScrollArea>) {
  return (
    <ScrollArea
      scrollFade
      className={cn(
        "h-auto max-h-[min(24rem,40dvh)] rounded-none [&>[data-slot=scroll-area-viewport][data-has-overflow-y]]:pe-2",
        className,
      )}
      {...props}
    />
  );
}

function Count({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "inline-flex min-w-(--composer-banner-icon-column,1em) flex-none justify-center font-medium text-muted-foreground tabular-nums",
        className,
      )}
      {...props}
    />
  );
}

function Body({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "min-w-0 ps-[calc(var(--composer-banner-icon-column)+(--spacing(1)))]",
        className,
      )}
      {...props}
    />
  );
}

function Dot({ className, ...props }: ComponentProps<"span">) {
  return (
    <span className={cn("size-1.5 flex-none rounded-full bg-current", className)} {...props} />
  );
}

function ToggleIcon({ expanded, className }: { expanded: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        buttonVariants({ size: "icon-xs", variant: "ghost" }),
        "pointer-events-none",
        className,
      )}
    >
      <ChevronDownIcon className={cn("size-3.5", !expanded && "rotate-180")} />
    </span>
  );
}

function Dismiss({ className, children, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button size="icon-xs" variant="ghost" className={className} {...props}>
      {children ?? <XIcon className="size-3.5" />}
    </Button>
  );
}

export const ComposerBanner = {
  Surface,
  Peek,
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
