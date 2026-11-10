import { ChevronRightIcon } from "lucide-react";
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
import { cn } from "../../lib/utils";
import { CHAT_BACKGROUND_GLASS_SURFACE_CLASSES } from "./ChatTimelineBackground";

export function MarkdownDetails({
  children,
  open = false,
  glass = false,
}: Pick<ComponentProps<"details">, "children" | "open"> & { glass?: boolean }) {
  const [isOpen, setIsOpen] = useState(open);
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
      : "Details";
  const content = childNodes.filter((_, index) => index !== summaryIndex);

  return (
    <div
      className={cn(
        "my-2 border-y border-border/60",
        glass && [CHAT_BACKGROUND_GLASS_SURFACE_CLASSES, "rounded-lg px-3"],
      )}
    >
      <Collapsible
        open={expanded}
        onOpenChange={setIsOpen}
        data-markdown-details=""
        data-markdown-details-open={expanded ? "true" : "false"}
      >
        <CollapsibleTrigger
          className="flex w-full items-center gap-2 py-2 text-left text-sm font-medium text-foreground data-panel-open:[&_svg]:rotate-90"
          data-markdown-details-summary=""
        >
          <ChevronRightIcon
            className="size-4 shrink-0 text-muted-foreground transition-transform"
            aria-hidden
          />
          <span>{summary}</span>
        </CollapsibleTrigger>
        <CollapsiblePanel ref={revealRef} hiddenUntilFound={searching}>
          <div
            className="pb-3 ps-6 text-foreground/[calc(90%+var(--appearance-contrast-boost)/10)]"
            data-markdown-details-content=""
          >
            {content}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}
