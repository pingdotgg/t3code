/** Fork-only: document quotes inside a sent message, which open the quoted file. */
import { scopeThreadRef } from "@lathe/client-runtime/environment";
import type { Citation, DocumentCitation } from "@lathe/contracts";
import { assistantCitationLabel, serializeCitation } from "@lathe/shared/assistantCitations";
import { ArrowUpRightIcon, FileTextIcon } from "lucide-react";
import { useState } from "react";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { textDirection } from "~/textDirection";
import { useRightPanelStore } from "../../rightPanelStore";
import { ContextChipPopover } from "../contextChipParts";
import { Button } from "../ui/button";
import { PopoverClose } from "../ui/popover";
import { getVirtualizedScrollFadeClassName } from "../ui/scroll-area";

export function openDocumentCitationSource(citation: DocumentCitation) {
  useRightPanelStore
    .getState()
    .openFile(
      scopeThreadRef(citation.environmentId, citation.threadId),
      citation.filePath,
      citation.startLine,
    );
}

/** Fork: a file quote inside a sent message, which opens the file at the quoted lines. */
export function DocumentCitationChip({ citation }: { citation: DocumentCitation }) {
  const label = assistantCitationLabel(citation);
  return (
    <ContextChipPopover
      kind="citation"
      icon={<FileTextIcon />}
      label={label}
      accessibleLabel={`Quoted text in ${citation.filePath}: ${label}`}
      copyMarkdown={serializeCitation(citation)}
    >
      <div className="flex max-h-[calc(var(--available-height)_-_1rem_-_2px)] flex-col items-start gap-3 p-1 text-sm">
        <AssistantCitationQuote citation={citation} />
        <PopoverClose
          render={
            <Button
              variant="outline"
              size="sm"
              onClick={() => openDocumentCitationSource(citation)}
            />
          }
        >
          <ArrowUpRightIcon aria-hidden="true" />
          Go to source
        </PopoverClose>
      </div>
    </ContextChipPopover>
  );
}

function AssistantCitationQuote({ citation }: { citation: Citation }) {
  const [fade, setFade] = useState({ top: false, bottom: false });
  const updateFade = (element: HTMLElement) => {
    const top = element.scrollTop > 1;
    const bottom = element.scrollHeight - element.clientHeight - element.scrollTop > 1;
    setFade((current) =>
      current.top === top && current.bottom === bottom ? current : { top, bottom },
    );
  };
  const observeFade = (element: HTMLDivElement | null) =>
    element ? observeResize(element, () => updateFade(element)) : undefined;
  return (
    <div
      ref={observeFade}
      onScroll={(event) => updateFade(event.currentTarget)}
      className={cn(
        "max-h-64 min-h-0 space-y-3 self-stretch overflow-y-auto whitespace-pre-wrap wrap-break-word",
        getVirtualizedScrollFadeClassName(fade),
      )}
    >
      <blockquote
        className="border-l-2 border-border pl-3 text-muted-foreground"
        dir={textDirection(citation.text)}
      >
        {citation.text}
      </blockquote>
      {citation.comment ? <p dir={textDirection(citation.comment)}>{citation.comment}</p> : null}
    </div>
  );
}
