import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { ChevronDownIcon, XIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";
import { Button, buttonVariants } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";

export type ComposerBannerVariant = "default" | "error" | "info" | "success" | "warning";

function Attachment({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-banner-attachment"
      className={cn(
        "mx-auto -mb-[calc(1rem+1px)] w-[calc(100%-2.75rem)] max-w-[45.25rem]",
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
      className={cn("flex items-end gap-1 [&>[data-composer-banner-width=fill]]:flex-1", className)}
      {...props}
    />
  );
}

function Root({
  className,
  placement = "attached",
  variant = "default",
  width = "fill",
  ...props
}: ComponentProps<"div"> & {
  placement?: "attached" | "floating";
  variant?: ComposerBannerVariant;
  width?: "fill" | "content";
}) {
  return (
    <div
      className={cn(
        "chat-composer-drawer-surface min-w-0 p-1 pb-[calc(var(--chat-composer-attachment-overlap)+--spacing(1))] text-xs leading-4 [--composer-banner-icon-column:--spacing(7)] sm:[--composer-banner-icon-column:--spacing(6)]",
        placement === "floating" &&
          "[--chat-composer-attachment-overlap:0px] before:rounded-[1rem]",
        width === "content" ? "w-fit max-w-full flex-none" : "@container",
        className,
      )}
      data-slot="composer-banner"
      data-composer-banner-surface={placement}
      data-composer-banner-width={width}
      data-variant={variant}
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
  layout?: "inline" | "wrap-actions";
}) {
  const rowProps = {
    className: cn(
      "group/banner-row grid min-h-(--composer-banner-icon-column) w-full min-w-0 grid-cols-[var(--composer-banner-icon-column)_minmax(0,1fr)_auto] items-center gap-x-1 text-start",
      "not-has-[>[data-slot=composer-banner-actions]]:grid-cols-[var(--composer-banner-icon-column)_minmax(0,1fr)]",
      "[&:is(button)]:cursor-pointer [&:is(button)]:rounded-[0.5rem] [&:is(button)]:focus-visible:outline-2 [&:is(button)]:focus-visible:-outline-offset-2 [&:is(button)]:focus-visible:outline-ring",
      layout === "wrap-actions" &&
        "@max-[400px]:flex @max-[400px]:flex-wrap @max-[400px]:gap-y-1 @max-[400px]:[&>[data-slot=composer-banner-content]]:min-h-(--composer-banner-icon-column) @max-[400px]:[&>[data-slot=composer-banner-content]]:flex-[1_1_10rem] @max-[400px]:[&>[data-slot=composer-banner-actions]]:ms-auto @max-[400px]:[&>[data-slot=composer-banner-actions]]:max-w-full @max-[400px]:has-[>[data-slot=composer-banner-icon]]:[&>[data-slot=composer-banner-actions]]:max-w-[calc(100%_-_var(--composer-banner-icon-column)_-_--spacing(1))]",
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
        "col-start-2 row-start-1 flex min-w-0 items-center gap-1 [&>[data-slot=composer-banner-separator]]:mx-0",
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
        "inline-flex min-w-[var(--composer-banner-icon-column,1em)] flex-none justify-center font-medium text-muted-foreground tabular-nums",
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
        "min-w-0 ps-[calc(var(--composer-banner-icon-column)+--spacing(1))]",
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
      className={cn(buttonVariants({ size: "icon-xs", variant: "ghost" }), className)}
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
  Attachment,
  Dock,
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
