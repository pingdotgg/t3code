import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  THREAD_DETAILS_PANEL_ROW_CLASS,
  THREAD_DETAILS_PANEL_CHOICE_ROW_CLASS,
  THREAD_DETAILS_PANEL_ICON_ACTION_CLASS,
  THREAD_DETAILS_PANEL_META_ACTION_CLASS,
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
} from "./threadDetailsPanelStyles";
import { ChevronRightIcon } from "lucide-react";

const parts = {
  row: THREAD_DETAILS_PANEL_ROW_CLASS,
  choice: THREAD_DETAILS_PANEL_CHOICE_ROW_CLASS,
  icon: THREAD_DETAILS_PANEL_ICON_ACTION_CLASS,
  meta: THREAD_DETAILS_PANEL_META_ACTION_CLASS,
};

export function ThreadDetailsControl({
  panel = true,
  part = "row",
  multiline = false,
  tone = "default",
  className,
  children,
  size = "default",
  variant = "default",
  render,
  ...props
}: ComponentProps<typeof Button> & {
  panel?: boolean;
  part?: keyof typeof parts;
  multiline?: boolean;
  tone?: "default" | "muted" | "primary" | "destructive";
}) {
  const control = useRender({
    defaultTagName: "button",
    render,
    props: mergeProps<"button">(
      {
        type: render ? undefined : "button",
        ...({ "data-part": part } as Record<string, string>),
        className: cn(
          parts[part],
          multiline && "h-auto min-h-8 py-0.75 disabled:opacity-100 sm:h-auto",
          tone === "muted" && "text-dim-foreground hover:text-foreground",
          tone === "primary" && "text-primary hover:text-primary",
          tone === "destructive" &&
            "text-destructive-foreground hover:text-destructive-foreground data-pressed:text-destructive-foreground",
          className,
        ),
      },
      props,
      {
        children:
          part === "choice" ? (
            <>
              {children}
              <ChevronRightIcon className={THREAD_DETAILS_PANEL_CHEVRON_CLASS} />
            </>
          ) : (
            children
          ),
      },
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
      >
        {children}
      </Button>
    );
  }
  return control;
}
