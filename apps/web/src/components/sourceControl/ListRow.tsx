/**
 * One row of an issue or pull request list. An issue and a change request are read the same way —
 * a glyph, a title, a line of facts under it, and what happened last on the right — so the frame is
 * written once here and each list fills the slots with what its own entries carry.
 *
 * The state glyph and everything past the repository stay with the caller: open, closed, merged and
 * draft are not one vocabulary, and neither are the facts each surface thinks worth the meta line.
 */
import type { ElementType, MouseEventHandler, ReactNode } from "react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SourceControlMetaLine } from "./actorPresentation";

export function ListRow({
  glyph,
  title,
  providerName,
  ProviderIcon,
  showProvider,
  number,
  onNumberContextMenu,
  repository,
  meta,
  matchedElsewhere,
  updatedAt,
  trailing,
  selected,
  onSelect,
}: {
  /** The caller's own state drawing, which is the one thing the two surfaces do not share. */
  glyph: ReactNode;
  title: string;
  providerName: string;
  ProviderIcon: ElementType<{ className?: string }>;
  /** Only when the list spans more than one host, where the repository alone is ambiguous. */
  showProvider: boolean;
  number: number;
  onNumberContextMenu?: MouseEventHandler<HTMLSpanElement>;
  /** Null where every row on screen comes from the same repository and naming it says nothing. */
  repository: string | null;
  /**
   * The rest of the meta line: who filed it, and whatever else the surface counts as a fact. One
   * keyed node per fact, as an array — the separators are drawn between children, and a fragment
   * would arrive as a single child and take the whole group as one fact.
   */
  meta: ReadonlyArray<ReactNode>;
  /**
   * A search found this, but in something the row does not show — a body, a comment, a commit
   * message. Saying so is the difference between a result and an apparently random row.
   */
  matchedElsewhere: boolean;
  updatedAt: string;
  /** What sits under the time: a diff stat, a comment count. */
  trailing: ReactNode;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      className={cn(
        "grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        // Offscreen rows are skipped for style, layout and paint: a long list costs what the
        // viewport shows, not what the pages have loaded. The intrinsic size keeps the
        // scrollbar honest while a row is skipped.
        "[contain-intrinsic-block-size:54px] [content-visibility:auto]",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      {glyph}
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">{title}</span>
        <SourceControlMetaLine className="mt-0.5 overflow-hidden text-xs text-muted-foreground/70">
          <span className="flex shrink-0 items-center gap-1">
            {showProvider ? (
              <Tooltip>
                <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
                  <ProviderIcon aria-label={providerName} className="size-3" />
                </TooltipTrigger>
                <TooltipPopup>{providerName}</TooltipPopup>
              </Tooltip>
            ) : null}
            <span onContextMenu={onNumberContextMenu}>#{number}</span>
          </span>
          {repository === null ? null : <span className="truncate">{repository}</span>}
          {meta}
          {matchedElsewhere ? (
            <span className="shrink-0 rounded-full border border-border/60 px-1.5 text-[10px]">
              matched in the description
            </span>
          ) : null}
        </SourceControlMetaLine>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5 text-xs text-muted-foreground/70 tabular-nums">
        <span>{formatRelativeTimeLabel(updatedAt)}</span>
        {trailing}
      </span>
    </button>
  );
}
