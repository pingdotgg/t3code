import { ChevronRight } from "lucide-react";
import { Children, isValidElement, type ComponentProps, type ReactNode, useState } from "react";

/** A `<details>` block from a reply: its summary opens and closes the content under it. */
export function Details({
  children,
  open = false,
}: Pick<ComponentProps<"details">, "children" | "open">) {
  const [expanded, setExpanded] = useState(open);
  const nodes = Children.toArray(children);
  const summaryIndex = nodes.findIndex(
    (child) => isValidElement(child) && child.type === "summary",
  );
  const summaryNode = nodes[summaryIndex];
  const summary =
    isValidElement<{ children?: ReactNode }>(summaryNode) && summaryNode.props.children
      ? summaryNode.props.children
      : "Details";
  return (
    <div className="my-2 border-y border-line" data-markdown-details-open={expanded}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 py-1.5 text-start font-medium text-fg"
      >
        <ChevronRight
          className={`size-4 shrink-0 text-muted transition-transform ${expanded ? "rotate-90" : ""}`}
          aria-hidden
        />
        <span>{summary}</span>
      </button>
      {expanded && (
        <div className="pb-2 pl-6">{nodes.filter((_, index) => index !== summaryIndex)}</div>
      )}
    </div>
  );
}
