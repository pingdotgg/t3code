import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import type { ReactNode } from "react";

import { useMediaQuery } from "../hooks/useMediaQuery";
import { cn } from "../lib/utils";

/**
 * A tab in the notch (pen N1JIfM): 28px, r8, 10px sides, 7px from the icon to
 * the label. It stays out of the titlebar drag region so its menus and
 * tooltips keep working in Electron. The focus ring is inset because the tab
 * sits on the pane edge, where the pane clip would cut an outer ring.
 */
export const PANE_TAB_CLASS =
  "inline-flex h-7 min-w-0 max-w-80 items-center gap-1.75 rounded-control px-2.5 text-label text-strong-foreground outline-none [-webkit-app-region:no-drag] focus-visible:inset-ring-2 focus-visible:inset-ring-ring";

/** The thread tab opens its action menu while keeping the notch's tab geometry. */
export function PaneTabButton({ className, render, ...props }: useRender.ComponentProps<"button">) {
  return useRender({
    defaultTagName: "button",
    render,
    props: mergeProps<"button">(
      {
        type: render ? undefined : "button",
        className: cn(
          PANE_TAB_CLASS,
          "cursor-pointer text-left hover:surface-ghost-hover",
          className,
        ),
      },
      props,
    ),
  });
}

/** Render first in a positioned pane header; index.css paints the notch on inset panes.
 * The final child may use data-pane-notch-add to retain tab-end padding without a surface.
 */
export function PaneNotch({ children }: { readonly children: ReactNode }) {
  // The tab sits on the window chrome where the notch shows, so light, black
  // chrome gives it the dark tokens there (index.css).
  const isMobile = useMediaQuery("max-md");
  return (
    <>
      <span aria-hidden data-pane-notch-corner="" />
      <div
        data-pane-notch=""
        data-chrome-scope={isMobile ? undefined : ""}
        className="relative isolate flex min-w-0 shrink items-center gap-1 self-stretch pe-(--pane-notch-tail) has-[>[data-pane-notch-add]]:pe-3.5"
      >
        {children}
      </div>
    </>
  );
}
