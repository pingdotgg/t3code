import { mergeProps } from "@base-ui/react/merge-props";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { useRender } from "@base-ui/react/use-render";
import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { ComposerSelectControl } from "./ComposerControl";
import {
  THREAD_DETAILS_PANEL_ROW_CLASS,
  THREAD_DETAILS_PANEL_SELECT_ROW_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_PRIMARY_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SECONDARY_CLASS,
  THREAD_DETAILS_PANEL_LINK_SPLIT_ACTION_CLASS,
  THREAD_DETAILS_PANEL_LINK_SPLIT_PRIMARY_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_CHECKS_CLASS,
  THREAD_DETAILS_PANEL_ICON_ACTION_CLASS,
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
} from "./threadDetailsPanelStyles";
import { ChevronDownIcon } from "lucide-react";

const parts = {
  row: THREAD_DETAILS_PANEL_ROW_CLASS,
  select: THREAD_DETAILS_PANEL_SELECT_ROW_CLASS,
  primary: THREAD_DETAILS_PANEL_SPLIT_PRIMARY_CLASS,
  secondary: THREAD_DETAILS_PANEL_SPLIT_SECONDARY_CLASS,
  action: THREAD_DETAILS_PANEL_LINK_SPLIT_ACTION_CLASS,
  "link-primary": THREAD_DETAILS_PANEL_LINK_SPLIT_PRIMARY_CLASS,
  checks: THREAD_DETAILS_PANEL_SPLIT_CHECKS_CLASS,
  icon: THREAD_DETAILS_PANEL_ICON_ACTION_CLASS,
};

/** Panel controls own their fixed density; toolbar controls use the standard Button variants. */
export function ThreadDetailsControl({
  panel = true,
  part = "row",
  multiline = false,
  tone = "default",
  className,
  size = "default",
  variant = "default",
  render,
  ...props
}: ComponentProps<typeof Button> & {
  panel?: boolean;
  part?: keyof typeof parts;
  multiline?: boolean;
  tone?: "default" | "muted" | "destructive";
}) {
  const control = useRender({
    defaultTagName: "button",
    render,
    props: mergeProps<"button">(
      {
        type: render ? undefined : "button",
        className: cn(
          "relative inline-flex shrink-0 cursor-pointer items-center whitespace-nowrap border outline-none transition-[box-shadow,scale] [&:active:not([aria-haspopup])]:scale-[0.97] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 disabled:pointer-events-none disabled:opacity-64 aria-disabled:cursor-not-allowed aria-disabled:opacity-64 [&_svg]:shrink-0",
          parts[part],
          multiline && "h-auto min-h-9 py-0.75 disabled:opacity-100 sm:h-auto",
          tone === "muted" && "text-muted-foreground/70 hover:text-foreground/80",
          tone === "destructive" &&
            "text-destructive hover:text-destructive data-pressed:text-destructive",
          className,
        ),
      },
      props,
    ),
  });
  if (!panel) {
    return (
      <Button
        {...props}
        render={render}
        size={multiline ? "sm-multiline" : size}
        variant={variant}
        className={className}
      />
    );
  }
  return control;
}

export function ThreadDetailsSelectControl({
  panel,
  children,
  className,
  ...props
}: Omit<SelectPrimitive.Trigger.Props, "className"> & { panel: boolean; className?: string }) {
  if (!panel) {
    return (
      <ComposerSelectControl {...props} size="xs" className={className}>
        {children}
      </ComposerSelectControl>
    );
  }
  return (
    <SelectPrimitive.Trigger
      {...props}
      render={<ThreadDetailsControl part="select" className={className} />}
    >
      {children}
      <SelectPrimitive.Icon data-slot="select-icon">
        <ChevronDownIcon className={THREAD_DETAILS_PANEL_CHEVRON_CLASS} />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}
