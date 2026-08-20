/**
 * The two shapes a summary is built from, on an issue and on a pull request alike: a labelled row
 * of facts at the top, and the collapsible sections under it. What goes in them is each surface's
 * own — reviewers and checks on one, assignees and labels on the other.
 */
import { ChevronRightIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { sectionCollapseAnchorScrollTop } from "./summarySectionScroll.logic";

export function SummaryMetaRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid min-h-8 grid-cols-[6rem_minmax(0,1fr)] items-center gap-2 py-1.5 text-xs">
      <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        {icon}
        {label}
      </span>
      <span className="min-w-0 text-foreground">{children}</span>
    </div>
  );
}

export function SummarySection({
  title,
  count,
  defaultOpen = true,
  actions,
  children,
}: {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  /** Controls riding on the heading row itself. A sibling of the trigger, not a child of it —
      a button cannot hold a button — and only while open, since they act on what is shown. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const headingRef = useRef<HTMLDivElement>(null);
  const setOpenWithScrollAnchor = (nextOpen: boolean) => {
    if (!nextOpen) {
      const heading = headingRef.current;
      const section = heading?.closest<HTMLElement>("[data-summary-section]");
      const scroller = heading?.closest<HTMLElement>("[data-summary-scroll]");
      if (heading && section && scroller) {
        const target = sectionCollapseAnchorScrollTop({
          scrollTop: scroller.scrollTop,
          viewportTop: scroller.getBoundingClientRect().top,
          sectionTop: section.getBoundingClientRect().top,
          headingTop: heading.getBoundingClientRect().top,
        });
        // Synchronous with the press: React commits the collapsed height before the browser
        // paints, so the reader sees the heading they pressed stay put rather than a jump first.
        if (target !== null) scroller.scrollTop = target;
      }
    }
    setOpen(nextOpen);
  };
  return (
    <Collapsible open={open} onOpenChange={setOpenWithScrollAnchor} data-summary-section>
      <div
        ref={headingRef}
        // The heading stays reachable while its body scrolls, like a diff file header.
        className="sticky top-0 z-10 flex w-full items-center border-t border-border/60 bg-background pr-4"
      >
        {/* Title first, chevron riding to its right, count last: the row reads as a heading
            with an affordance rather than a tree node. */}
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1.5 px-4 py-3 text-left text-sm font-medium">
          <span>{title}</span>
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3.5 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
          {count === undefined ? null : (
            <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
          )}
        </CollapsibleTrigger>
        {open ? actions : null}
      </div>
      <CollapsiblePanel>
        <div className="px-4 pb-4">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
