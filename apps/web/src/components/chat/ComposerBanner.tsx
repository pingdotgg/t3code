import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { ChevronDownIcon, XIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";
import { Button, buttonVariants } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import "./ComposerBanner.css";

export type ComposerBannerVariant = "default" | "error" | "info" | "success" | "warning";

function Attachment({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("composer-banner-attachment", className)} {...props} />;
}

function Dock({ className, ...props }: ComponentProps<"div">) {
  return <Attachment className={cn("composer-banner-dock", className)} {...props} />;
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
      className={cn("chat-composer-drawer-surface composer-banner", className)}
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
    className: cn("composer-banner-row", className),
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
  return <span aria-hidden className={cn("composer-banner-icon", className)} {...props} />;
}

function Content({ className, ...props }: ComponentProps<"span">) {
  return <span className={cn("composer-banner-content", className)} {...props} />;
}

function Separator() {
  return (
    <span aria-hidden className="composer-banner-separator">
      ·
    </span>
  );
}

function Actions({ className, ...props }: ComponentProps<"span">) {
  return <span className={cn("composer-banner-actions", className)} {...props} />;
}

/** Child rows keep their parent's columns and begin immediately after its header. */
function Children({ className, render, ...props }: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    render,
    props: mergeProps<"div">({ className: cn("composer-banner-children", className) }, props),
  });
}

/** Bounded banner content uses the app's scroll area and fades only overflowing edges. */
function Scroll({ className, ...props }: ComponentProps<typeof ScrollArea>) {
  return (
    <ScrollArea
      scrollFade
      className={cn(
        "composer-banner-scroll h-auto max-h-[min(24rem,40dvh)] rounded-none",
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
        "composer-banner-count font-medium text-muted-foreground tabular-nums",
        className,
      )}
      {...props}
    />
  );
}

function Body({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("composer-banner-body", className)} {...props} />;
}

function Dot({ className, ...props }: ComponentProps<"span">) {
  return <span className={cn("composer-banner-dot", className)} {...props} />;
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
