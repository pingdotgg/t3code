import { T, useGT } from "gt-react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useRef, type ComponentProps } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  serializeTableElementToCsv,
  serializeTableElementToHtml,
  serializeTableElementToMarkdown,
} from "../../markdown-clipboard";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { reportMarkdownActionFailure, type TableCopyFormat } from "./markdownActionFailure";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

type TableTextFormat = Exclude<TableCopyFormat, "png">;

const TABLE_COPY_SERIALIZERS: Record<TableTextFormat, (table: Element) => string> = {
  markdown: serializeTableElementToMarkdown,
  csv: serializeTableElementToCsv,
  html: serializeTableElementToHtml,
};

// Loaded on first use; the clipboard write still starts inside the click.
const renderTablePng = (table: HTMLTableElement) =>
  import("./tablePng").then((module) => module.renderTablePng(table));

export function MarkdownTable({ children, ...props }: ComponentProps<"table">) {
  const gt = useGT();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const {
    copyToClipboard,
    copyPngToClipboard,
    isCopied: copied,
  } = useCopyToClipboard<TableCopyFormat>({
    timeout: 1200,
    onError: (cause, format) =>
      reportMarkdownActionFailure({ operation: "copy-table", format }, cause),
  });
  const copyLabel = copied ? gt("Copied") : gt("Copy table");
  // Insecure origins (plain http over a LAN or tailnet) have no async clipboard for images.
  const canCopyPng =
    typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function";

  const handleCopy = (format: TableTextFormat) => {
    const table = containerRef.current?.querySelector("table");
    if (!table) return;
    const text = TABLE_COPY_SERIALIZERS[format](table);
    // Plain-text targets get the markup; rich targets (mail, docs, wikis) paste a real table.
    copyToClipboard(
      text,
      format,
      format === "html" ? { "text/html": `<meta charset="utf-8">${text}` } : undefined,
      { requireHtml: format === "html" },
    );
  };

  const handleCopyPng = () => {
    const table = containerRef.current?.querySelector("table");
    if (!table) return;
    copyPngToClipboard(() => renderTablePng(table), "png");
  };

  return (
    <div ref={containerRef} className="chat-markdown-table-container">
      <ScrollArea radius="none" chainVerticalScroll scrollFade className="w-full max-w-full">
        <table {...props}>{children}</table>
      </ScrollArea>
      {/* Stays within the row's px-1: the chat lane clips sideways overflow. */}
      <div className="mt-0.5 -mx-1 flex items-center justify-end select-none">
        <Menu>
          <SharedTooltipTrigger
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
            label={copyLabel}
          >
            {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
          </SharedTooltipTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => handleCopy("markdown")}>
              <T>Copy as Markdown</T>
            </MenuItem>
            <MenuItem onClick={() => handleCopy("csv")}>
              <T>Copy as CSV</T>
            </MenuItem>
            <MenuItem onClick={() => handleCopy("html")}>
              <T>Copy as HTML</T>
            </MenuItem>
            {canCopyPng ? (
              <MenuItem onClick={handleCopyPng}>
                <T>Copy as PNG</T>
              </MenuItem>
            ) : null}
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}
