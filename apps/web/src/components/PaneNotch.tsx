import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { useLayoutEffect, useRef, type ReactNode } from "react";

import { useMediaQuery } from "../hooks/useMediaQuery";
import { observeResize } from "../lib/observeResize";
import { cn } from "../lib/utils";

/**
 * A tab in the notch (pen N1JIfM): 28px, r8, 10px sides, 7px from the icon to
 * the label. It stays out of the titlebar drag region so its menus and
 * tooltips keep working in Electron. The focus ring is inset because the tab
 * sits on the pane edge, where the pane clip would cut an outer ring.
 */
export const PANE_TAB_CLASS =
  "inline-flex h-7 min-w-0 max-w-80 items-center gap-1.75 rounded-control px-2.5 text-control text-strong-foreground outline-none [-webkit-app-region:no-drag] focus-visible:inset-ring-2 focus-visible:inset-ring-ring";

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

/**
 * The body under a pane header that has no surface of its own (a surface tab's,
 * the launcher's, Settings'): it may reach up under the header by
 * --pane-surface-reach (see [data-surface-reaches-under-header] in index.css),
 * and stays a layer below it whatever its own z-indexes.
 */
export const PANE_BODY_UNDER_HEADER_CLASS =
  "isolate [--pane-surface-reach:var(--pane-header-overlap,0px)]";

// Notches inside each pane or inset. index.css squares the corner of a host
// marked data-pane-notched; matching hosts with :has([data-pane-notch])
// instead had the browser recheck their whole subtree on every DOM change.
const notchCounts = {
  left: new WeakMap<Element, number>(),
  right: new WeakMap<Element, number>(),
};

function markNotchHost(host: Element | null, side: "left" | "right"): () => void {
  if (!host) return () => {};
  const counts = notchCounts[side];
  const attribute = side === "left" ? "data-pane-notched" : "data-pane-notched-right";
  counts.set(host, (counts.get(host) ?? 0) + 1);
  host.setAttribute(attribute, "");
  return () => {
    const count = (counts.get(host) ?? 1) - 1;
    counts.set(host, count);
    if (count === 0) host.removeAttribute(attribute);
  };
}

const PANE_NOTCH_MERGE_MARGIN_PX = 4;
const notchHeaders = new WeakMap<
  HTMLElement,
  {
    readonly notches: Map<HTMLDivElement, "left" | "right">;
    readonly refresh: () => void;
  }
>();

/** One subscription per header, including breakpoint-switched controls. */
function observeNotchGap(notch: HTMLDivElement, side: "left" | "right"): () => void {
  const header = notch.closest<HTMLElement>("[data-pane-header]");
  if (!header) return () => {};
  let registration = notchHeaders.get(header);
  if (!registration) {
    const notches = new Map<HTMLDivElement, "left" | "right">();
    let stopObserving = () => {};
    const update = () => {
      let left: HTMLDivElement | undefined;
      let right: HTMLDivElement | undefined;
      for (const [element, notchSide] of notches) {
        if (element.offsetWidth === 0) continue;
        if (notchSide === "left") left = element;
        else right = element;
      }
      let merged = false;
      if (left && right) {
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        // The pseudo-element resolves --pane-notch-tail to pixels, including rem sizing.
        const tail = Number.parseFloat(getComputedStyle(left, "::after").width);
        const mergeGap = 2 * tail + PANE_NOTCH_MERGE_MARGIN_PX;
        // Compare in layout pixels even when the overview scales the pane.
        const scale = leftRect.width / left.offsetWidth;
        merged = scale > 0 && (rightRect.left - leftRect.right) / scale < mergeGap;
      }
      if (header.hasAttribute("data-pane-notches-merged") !== merged) {
        header.toggleAttribute("data-pane-notches-merged", merged);
      }
    };
    const refresh = () => {
      stopObserving();
      const sides = new Set(notches.values());
      // Header resizing moves fixed-width notches without resizing either notch.
      stopObserving =
        sides.size === 2 ? observeResize([header, ...notches.keys()], update) : () => {};
      update();
    };
    registration = { notches, refresh };
    notchHeaders.set(header, registration);
  }
  const { notches, refresh } = registration;
  notches.set(notch, side);
  refresh();
  return () => {
    notches.delete(notch);
    refresh();
    if (notches.size === 0) notchHeaders.delete(header);
  };
}

/** Render first inside a positioned pane header starting at the pane edge. Keep the plus last so the
 * notch includes its trailing padding. */
export function PaneNotch({
  children,
  side = "left",
  marksHost = true,
  className,
}: {
  readonly children: ReactNode;
  readonly side?: "left" | "right";
  /** Off for a notch drawn where it cannot show (a hidden overview thumbnail). */
  readonly marksHost?: boolean;
  readonly className?: string;
}) {
  // The tab sits on the window chrome where the notch shows, so light, black
  // chrome gives it the dark tokens there (index.css).
  const isMobile = useMediaQuery("max-md");
  const notchRef = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Mark the mounted notch ancestors and remove those external DOM markers on cleanup.
  useLayoutEffect(() => {
    const notch = notchRef.current;
    if (!notch || !marksHost) return;
    const unmarkPane = markNotchHost(
      notch.closest(
        side === "right"
          ? "[data-layout-tab-id], [data-pane-notch-host]"
          : "[data-layout-tab-id]",
      ),
      side,
    );
    const unmarkInset = markNotchHost(notch.closest('[data-slot="sidebar-inset"]'), side);
    return () => {
      unmarkPane();
      unmarkInset();
    };
  }, [marksHost, side]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Observe the notch DOM gap before paint and stop observing when its host changes.
  useLayoutEffect(() => {
    const notch = notchRef.current;
    if (!notch || !marksHost || isMobile) return;
    return observeNotchGap(notch, side);
  }, [isMobile, marksHost, side]);
  return (
    <>
      <span aria-hidden data-pane-notch-corner={side === "left" ? "" : side} />
      <div
        ref={notchRef}
        data-pane-notch={side === "left" ? "" : side}
        data-chrome-scope={isMobile ? undefined : ""}
        className={cn(
          "relative isolate flex min-w-0 shrink items-center gap-1 self-stretch",
          side === "left"
            ? "pe-(--pane-notch-tail) has-[>[data-pane-notch-add]]:pe-3.5"
            : "md:ps-(--pane-notch-tail)",
          className,
        )}
      >
        {children}
      </div>
    </>
  );
}
