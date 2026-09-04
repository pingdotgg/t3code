import {
  codexCitationMarkdown,
  codexCitationText,
  type CodexCitation,
} from "@t3tools/client-runtime/codex-citations";
import { cn } from "~/lib/utils";
import { CHAT_INLINE_CHIP_CLASS_NAME } from "../composerInlineChip";
import {
  Popover,
  PopoverDescription,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "../ui/popover";

/** A source reference stays inspectable even when Codex does not supply its destination. */
export function CodexCitationChip({ citation }: { citation: CodexCitation }) {
  const sourceNumbers = citation.sources.map((source) => source.number).join(", ");
  const label = `${citation.sources.length === 1 ? "Source" : "Sources"} ${sourceNumbers}`;

  return (
    <span
      className="chat-markdown-source-citation"
      data-markdown-copy={codexCitationMarkdown(citation)}
      data-markdown-copy-text={codexCitationText(citation)}
    >
      <Popover>
        <PopoverTrigger
          className={cn(
            CHAT_INLINE_CHIP_CLASS_NAME,
            "cursor-pointer align-baseline text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
          )}
          aria-label={`View ${label.toLowerCase()}`}
          title={`${label}. Source URL unavailable.`}
        >
          <span className="truncate tabular-nums">{sourceNumbers}</span>
        </PopoverTrigger>
        <PopoverPopup side="top" align="start" className="w-72 max-w-[calc(100vw-2rem)]">
          <PopoverTitle className="text-sm">{label}</PopoverTitle>
          <dl className="mt-3 space-y-2 text-xs">
            {citation.sources.map((source) => (
              <div key={source.id} className="flex items-baseline gap-3">
                <dt className="shrink-0 text-muted-foreground">Source {source.number}</dt>
                <dd className="min-w-0 font-mono wrap-anywhere select-text">{source.id}</dd>
              </div>
            ))}
            {citation.locator ? (
              <div className="flex items-baseline gap-3">
                <dt className="shrink-0 text-muted-foreground">Lines</dt>
                <dd className="min-w-0 font-mono wrap-anywhere select-text">{citation.locator}</dd>
              </div>
            ) : null}
          </dl>
          <PopoverDescription className="mt-3 text-xs">
            Source URL unavailable. Codex supplied source IDs without destination links.
          </PopoverDescription>
        </PopoverPopup>
      </Popover>
    </span>
  );
}
