/**
 * Visual primitives shared by controls when they are rendered in the thread details panel.
 *
 * The core control variants intentionally become denser at the `sm` breakpoint. The panel has
 * its own fixed density, so every size and type override here includes its desktop counterpart.
 */
export const THREAD_DETAILS_PANEL_ROW_CLASS =
  "h-9 w-full justify-start gap-2.5 rounded-lg border-transparent bg-transparent px-2.5 text-[13px] font-medium text-foreground/80 shadow-none before:shadow-none sm:h-9 sm:text-[13px]";

export const THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS =
  "h-9 w-full justify-start gap-2.5 rounded-lg border border-transparent px-2.5 text-[13px] font-medium text-foreground/80 sm:h-9 sm:text-[13px]";

export const THREAD_DETAILS_PANEL_ICON_CLASS = "size-4 shrink-0 text-muted-foreground";

export const THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS =
  "group/thread-details-action flex w-full items-center rounded-lg transition-colors hover:bg-muted/65 focus-within:bg-muted/65";

export const THREAD_DETAILS_PANEL_SPLIT_PRIMARY_CLASS =
  "h-9 min-w-0 flex-1 justify-start gap-2.5 rounded-e-none border-transparent bg-transparent px-2.5 pr-2 text-[13px] font-medium text-foreground/80 shadow-none before:shadow-none sm:h-9 sm:text-[13px] [&:hover]:bg-transparent [&[data-pressed]]:bg-transparent";

export const THREAD_DETAILS_PANEL_SPLIT_SECONDARY_CLASS =
  "h-9 w-8 rounded-s-none border-transparent bg-transparent px-0 shadow-none before:shadow-none sm:h-9 sm:w-8 [&:hover]:bg-transparent [&[data-pressed]]:bg-transparent";

export const THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS = "h-4 w-px shrink-0 bg-border/65";
