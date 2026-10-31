import { MENU_ITEM_ROW_CLASS, MENU_SUB_TRIGGER_ROW_CLASS } from "../ui/menu";

/** Compact workspace rows shared by the details cards. */
const PANEL_ROW_INTERACTION_CLASS =
  "relative w-full min-w-0 text-left hover:surface-selected-soft data-pressed:surface-selected-soft data-popup-open:surface-selected-soft hover:text-strong-foreground data-popup-open:text-strong-foreground hover:[&>svg:not([class*='text-'])]:text-foreground data-popup-open:[&>svg:not([class*='text-'])]:text-foreground disabled:pointer-events-none disabled:opacity-45 aria-disabled:cursor-not-allowed aria-disabled:opacity-45 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

export const THREAD_DETAILS_PANEL_ROW_CLASS = `${MENU_ITEM_ROW_CLASS} ${PANEL_ROW_INTERACTION_CLASS} min-h-7 sm:min-h-7 gap-2.5 ps-2.5 pe-1 text-meta`;
export const THREAD_DETAILS_PANEL_CHOICE_ROW_CLASS = `${MENU_SUB_TRIGGER_ROW_CLASS} ${PANEL_ROW_INTERACTION_CLASS} min-h-7 sm:min-h-7 gap-2.5 ps-2.5 pe-1 text-meta`;

export const THREAD_DETAILS_PANEL_LABEL_CLASS = "min-w-0 truncate";
export const THREAD_DETAILS_PANEL_META_CLASS =
  "ms-auto flex shrink-0 items-center gap-1.5 text-caption tabular-nums text-dim-foreground";
export const THREAD_DETAILS_PANEL_ICON_CLASS = "size-4 shrink-0 text-muted-foreground";
export const THREAD_DETAILS_PANEL_CHEVRON_CLASS =
  "-me-1 ms-auto size-3 shrink-0 text-dim-foreground";
export const THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS = `${THREAD_DETAILS_PANEL_ROW_CLASS} cursor-default hover:bg-transparent hover:text-foreground`;
export const THREAD_DETAILS_PANEL_ACTION_GROUP_CLASS = "flex w-full min-w-0 items-center";
export const THREAD_DETAILS_PANEL_ICON_ACTION_CLASS = `${THREAD_DETAILS_PANEL_ROW_CLASS} size-6 min-h-6 w-6 justify-center p-0 sm:min-h-6`;
export const THREAD_DETAILS_PANEL_META_ACTION_CLASS = `${THREAD_DETAILS_PANEL_ROW_CLASS} h-6 min-h-6 w-auto gap-1 px-1.5 text-meta text-muted-foreground sm:min-h-6`;
