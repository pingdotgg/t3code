import { useGT } from "gt-react";
import { ChevronRightIcon } from "lucide-react";
import { flushSync } from "react-dom";
import {
  Children,
  isValidElement,
  use,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { findRevealRef, MarkdownFindContext } from "./markdownFindContext";

const focusOnMount = (element: HTMLElement | null) => {
  if (element && element.ownerDocument.activeElement === element.ownerDocument.body)
    element.focus();
};

export function MarkdownDetails({
  children,
  open = false,
  dir,
}: Pick<ComponentProps<"details">, "children" | "open" | "dir">) {
  const gt = useGT();
  const [isOpen, setIsOpen] = useState(open);
  const [armed, setArmed] = useState<"hover" | "focus" | null>(null);
  const searching = use(MarkdownFindContext);
  const expanded = isOpen;
  const revealForFind = () => setIsOpen(true);
  // Base UI only listens for `beforematch` on a panel mounted at its first
  // render; a closed panel mounts later, when find starts, so listen here.
  const revealRef = findRevealRef(revealForFind);
  const childNodes = Children.toArray(children);
  const summaryIndex = childNodes.findIndex(
    (child) => isValidElement(child) && child.type === "summary",
  );
  const summaryNode = summaryIndex >= 0 ? childNodes[summaryIndex] : null;
  const summary =
    isValidElement<{ children?: ReactNode }>(summaryNode) && summaryNode.props.children
      ? summaryNode.props.children
      : gt("Details", { $context: "fallback title of a collapsible section" });
  const content = childNodes.filter((_, index) => index !== summaryIndex);

  // Most details stay closed: mount Base UI on hover or focus, before the first click.
  if (!armed && !expanded && !searching) {
    return (
      <div className="my-2 border-y border-border" dir={dir}>
        <div data-slot="collapsible" data-markdown-details="" data-markdown-details-open="false">
          <button
            type="button"
            aria-expanded="false"
            className="flex w-full cursor-pointer text-start [&:dir(rtl)_svg]:rotate-180"
            data-slot="collapsible-trigger"
            data-markdown-details-summary=""
            // Synchronously, so the pointer's next events reach Base UI's trigger.
            onPointerEnter={() => flushSync(() => setArmed("hover"))}
            onFocus={() => flushSync(() => setArmed("focus"))}
            onClick={() => {
              setArmed("hover");
              setIsOpen(true);
            }}
          >
            <span className="flex w-full items-center gap-2 py-2 text-label text-foreground">
              <ChevronRightIcon
                className="size-4 shrink-0 text-dim-foreground transition-transform"
                aria-hidden
              />
              <span>{summary}</span>
            </span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="my-2 border-y border-border" dir={dir}>
      <Collapsible
        open={expanded}
        onOpenChange={setIsOpen}
        data-markdown-details=""
        data-markdown-details-open={expanded ? "true" : "false"}
      >
        <CollapsibleTrigger
          className="flex w-full items-center gap-2 py-2 text-start text-label text-foreground [&:dir(rtl):not([data-panel-open])_svg]:rotate-180 data-panel-open:[&_svg]:rotate-90"
          data-markdown-details-summary=""
          // Keyboard focus armed it, and the swap replaced the focused button.
          ref={armed === "focus" ? focusOnMount : undefined}
        >
          <ChevronRightIcon
            className="size-4 shrink-0 text-dim-foreground transition-transform"
            aria-hidden
          />
          <span>{summary}</span>
        </CollapsibleTrigger>
        <CollapsiblePanel ref={revealRef} hiddenUntilFound={searching}>
          <div className="pb-3 ps-6 text-foreground" data-markdown-details-content="">
            {content}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}
