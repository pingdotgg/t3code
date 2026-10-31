import { cva, type VariantProps } from "class-variance-authority";
import { Children, isValidElement } from "react";
import type * as React from "react";

import { cn } from "~/lib/utils";

// Status alerts are the tint recipe: the tone's hue as a faint gradient fill
// and rim, with the icon in the tone and the text in the normal tiers.
const alertVariants = cva("relative rounded-lg px-3.5 py-3 text-body text-foreground", {
  defaultVariants: {
    variant: "default",
  },
  variants: {
    variant: {
      default:
        "surface-tint [--surface-tint:var(--muted-foreground)] [&_svg]:text-muted-foreground",
      sidebar:
        "rounded-lg border border-sidebar-border bg-sidebar-control-surface px-2 py-1.5 text-[11px] leading-4 [&_[data-slot=alert-description]]:block [&_[data-slot=alert-description]]:text-sidebar-muted-foreground",
      // Bare sidebar text, for transient confirmations that should not read as a card.
      "sidebar-plain":
        "px-(--sidebar-row-content-inset) py-1.5 text-[11px] leading-4 [&_[data-slot=alert-description]]:block [&_[data-slot=alert-description]]:text-sidebar-muted-foreground",
      error:
        "surface-tint [--surface-tint:var(--error)] [--surface-tint-fill:var(--error-alert-fill)] [--surface-tint-rim:var(--error-alert-rim)] [&_svg]:text-error-foreground",
      info: "surface-tint [--surface-tint:var(--info)] [--surface-tint-fill:var(--info-alert-fill)] [--surface-tint-rim:var(--info-alert-rim)] [&_svg]:text-info-foreground",
      warning:
        "surface-tint [--surface-tint:var(--warning)] [--surface-tint-fill:var(--warning-alert-fill)] [--surface-tint-rim:var(--warning-alert-rim)] [&_svg]:text-warning-foreground",
    },
  },
});

function alertChildSlot(child: React.ReactElement): string | undefined {
  const propsSlot = (child.props as Record<string, string | undefined>)["data-slot"];
  if (propsSlot) {
    return propsSlot;
  }

  const type = child.type as { displayName?: string; name?: string };
  switch (type.displayName ?? type.name) {
    case "AlertAction":
      return "alert-action";
    case "AlertTitle":
      return "alert-title";
    case "AlertDescription":
      return "alert-description";
    default:
      return undefined;
  }
}

function Alert({
  className,
  variant,
  controlAlignment = "center",
  children,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof alertVariants> & {
    controlAlignment?: "center" | "first-line";
  }) {
  const icon: React.ReactNode[] = [];
  const content: React.ReactNode[] = [];
  const action: React.ReactNode[] = [];

  Children.forEach(children, (child) => {
    if (!isValidElement(child)) {
      content.push(child);
      return;
    }
    const slot = alertChildSlot(child);
    if (slot === "alert-action") {
      action.push(child);
    } else if (slot === "alert-title" || slot === "alert-description") {
      content.push(child);
    } else {
      icon.push(child);
    }
  });

  return (
    <div
      className={cn(alertVariants({ variant }), className)}
      data-slot="alert"
      data-variant={variant ?? "default"}
      role="alert"
      {...props}
    >
      <div
        className={cn(
          "flex gap-2",
          controlAlignment === "first-line" ? "items-start" : "items-center",
          controlAlignment === "first-line" &&
            action.length > 0 &&
            "min-h-7 pt-1 sm:min-h-6 sm:pt-0.5",
        )}
      >
        {icon.length > 0 && (
          <div
            data-slot="alert-icon"
            className={cn(
              "flex shrink-0 items-center justify-center",
              controlAlignment === "first-line"
                ? "h-lh w-4 [&>svg]:size-3.5"
                : "h-lh w-4 self-start [&>svg]:size-3.5",
            )}
          >
            {icon}
          </div>
        )}
        {content.length > 0 && (
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">{content}</div>
        )}
        {action.length > 0 && (
          <div
            className={cn(
              "flex shrink-0 items-center",
              controlAlignment === "first-line" ? "h-lh self-start" : "self-center",
            )}
          >
            {action}
          </div>
        )}
      </div>
    </div>
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("text-label text-foreground", className)}
      data-slot="alert-title"
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col gap-2.5 text-muted-foreground", className)}
      data-slot="alert-description"
      {...props}
    />
  );
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex gap-1", className)} data-slot="alert-action" {...props} />;
}

AlertTitle.displayName = "AlertTitle";
AlertDescription.displayName = "AlertDescription";
AlertAction.displayName = "AlertAction";

export { Alert, AlertTitle, AlertDescription, AlertAction };
