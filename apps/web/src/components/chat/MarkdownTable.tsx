import { Check, Copy, Maximize2, Minimize2 } from "lucide";
import { useRef, useState, type ComponentProps } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { getClientSettings } from "../../hooks/useSettings";
import { observeResize } from "../../lib/observeResize";
import {
  serializeTableElementToCsv,
  serializeTableElementToMarkdown,
} from "../../markdown-clipboard";
import { MorphIcon } from "../MorphIcon";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { reportMarkdownActionFailure } from "./markdownActionFailure";

/**
 * Whether any cell is clipped in the unwrapped layout. Only then does the wrap
 * toggle change anything, so short tables hide it. Measures with the container
 * briefly unwrapped and restores it before the browser paints.
 */
function tableHasClippedCells(container: HTMLElement, table: HTMLTableElement): boolean {
  const viewport = table.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
  const scrollLeft = viewport?.scrollLeft ?? 0;
  const previous = container.dataset.expanded;
  container.dataset.expanded = "false";
  try {
    for (const row of table.rows) {
      for (const cell of row.cells) {
        if (cell.scrollWidth > cell.clientWidth) return true;
      }
    }
    return false;
  } finally {
    if (previous === undefined) delete container.dataset.expanded;
    else container.dataset.expanded = previous;
    // The unwrapped layout can be narrower and clamp a sideways scroll.
    if (viewport && scrollLeft > 0) viewport.scrollLeft = scrollLeft;
  }
}

export function MarkdownTable({ children, ...props }: ComponentProps<"table">) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(() => getClientSettings().wordWrap);
  const [hasClippedCells, setHasClippedCells] = useState(false);
  const { copyToClipboard, isCopied: copied } = useCopyToClipboard<"markdown" | "csv">({
    timeout: 1200,
    onError: (cause, format) =>
      reportMarkdownActionFailure({ operation: "copy-table", format }, cause),
  });
  const expandLabel = expanded ? "Collapse table cells" : "Expand table cells";
  const copyLabel = copied ? "Copied" : "Copy table";

  // React calls this with null when a previous attach returned no cleanup.
  const attachContainer = (container: HTMLDivElement | null) => {
    containerRef.current = container;
    const table = container?.querySelector("table");
    if (!container || !table) return;
    const measure = () => setHasClippedCells(tableHasClippedCells(container, table));
    measure();
    // A streamed cell can grow until it clips while the table keeps its size, and a
    // narrower column can clip a cell without this component rendering.
    const mutations = new MutationObserver(measure);
    mutations.observe(table, { childList: true, characterData: true, subtree: true });
    const stopResize = observeResize(table, measure);
    return () => {
      mutations.disconnect();
      stopResize();
      containerRef.current = null;
    };
  };

  const handleCopy = (format: "markdown" | "csv") => {
    const table = containerRef.current?.querySelector("table");
    if (!table) return;
    copyToClipboard(
      format === "markdown"
        ? serializeTableElementToMarkdown(table)
        : serializeTableElementToCsv(table),
      format,
    );
  };

  return (
    <div
      ref={attachContainer}
      className="chat-markdown-table-container"
      data-expanded={expanded ? "true" : "false"}
    >
      <ScrollArea radius="none" chainVerticalScroll scrollFade className="w-full max-w-full">
        <table {...props}>{children}</table>
      </ScrollArea>
      {/* Stays within the row's px-1: the chat lane clips sideways overflow. */}
      <div className="mt-0.5 -mx-1 flex items-center justify-between select-none">
        {hasClippedCells ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant={expanded ? "secondary" : "ghost-muted"}
                  size="icon-xs"
                  aria-pressed={expanded}
                  onClick={() => setExpanded((value) => !value)}
                  aria-label={expandLabel}
                />
              }
            >
              <MorphIcon className="size-3" icon={expanded ? Minimize2 : Maximize2} />
            </TooltipTrigger>
            <TooltipPopup side="top">{expandLabel}</TooltipPopup>
          </Tooltip>
        ) : (
          <span />
        )}
        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost-muted"
                      size="icon-xs"
                      aria-label={copyLabel}
                    />
                  }
                />
              }
            >
              <MorphIcon className="size-3" icon={copied ? Check : Copy} />
            </TooltipTrigger>
            <TooltipPopup side="top">{copyLabel}</TooltipPopup>
          </Tooltip>
          <MenuPopup align="end">
            <MenuItem onClick={() => handleCopy("markdown")}>Copy as Markdown</MenuItem>
            <MenuItem onClick={() => handleCopy("csv")}>Copy as CSV</MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}
