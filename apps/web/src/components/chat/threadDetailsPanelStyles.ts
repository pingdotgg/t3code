/**
 * Visual primitives shared by controls when they are rendered in the thread details panel.
 *
 * Panel controls keep one density at every breakpoint, independent of toolbar button sizes.
 */
const THREAD_DETAILS_PANEL_RESTING_BUTTON_SURFACE_CLASS = "bg-transparent shadow-none";

const THREAD_DETAILS_PANEL_HOVER_SURFACE_CLASS =
  "hover:!bg-black/[0.035] data-pressed:!bg-black/[0.035] dark:hover:!bg-white/[0.08] dark:data-pressed:!bg-white/[0.08]";

const THREAD_DETAILS_PANEL_ROW_SURFACE_CLASS = `${THREAD_DETAILS_PANEL_RESTING_BUTTON_SURFACE_CLASS} ${THREAD_DETAILS_PANEL_HOVER_SURFACE_CLASS}`;
const THREAD_DETAILS_PANEL_SPLIT_BUTTON_SURFACE_CLASS = `${THREAD_DETAILS_PANEL_ROW_SURFACE_CLASS} data-popup-open:!bg-black/[0.035] dark:data-popup-open:!bg-white/[0.08]`;
const THREAD_DETAILS_PANEL_SPLIT_GROUP_SURFACE_CLASS = `${THREAD_DETAILS_PANEL_HOVER_SURFACE_CLASS} has-[[data-popup-open]]:bg-black/[0.035] dark:has-[[data-popup-open]]:bg-white/[0.08]`;

export const THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS = "gap-2.5 px-2.5 text-left";

// Center capitals with icons. Only clip horizontally so truncated labels retain
// accents and descenders outside the trimmed text box.
export const THREAD_DETAILS_PANEL_LABEL_CLASS =
  "[text-box:trim-both_cap_alphabetic] overflow-x-clip overflow-y-visible";

const THREAD_DETAILS_PANEL_CONTROL_CLASS = `h-8 min-w-0 rounded-lg border-transparent ${THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS} text-[13px] font-medium text-foreground/80`;

export const THREAD_DETAILS_PANEL_ROW_CLASS = `${THREAD_DETAILS_PANEL_CONTROL_CLASS} w-full justify-start ${THREAD_DETAILS_PANEL_ROW_SURFACE_CLASS}`;

export const THREAD_DETAILS_PANEL_SELECT_ROW_CLASS = `${THREAD_DETAILS_PANEL_ROW_CLASS} pe-0 [&_[data-slot=select-icon]]:-me-px [&_[data-slot=select-icon]]:relative [&_[data-slot=select-icon]]:flex [&_[data-slot=select-icon]]:h-full [&_[data-slot=select-icon]]:w-8 [&_[data-slot=select-icon]]:shrink-0 [&_[data-slot=select-icon]]:items-center [&_[data-slot=select-icon]]:justify-center [&_[data-slot=select-icon]]:before:absolute [&_[data-slot=select-icon]]:before:-left-px [&_[data-slot=select-icon]]:before:top-1/2 [&_[data-slot=select-icon]]:before:h-4 [&_[data-slot=select-icon]]:before:w-px [&_[data-slot=select-icon]]:before:-translate-y-1/2 [&_[data-slot=select-icon]]:before:bg-border/65 [&_[data-slot=select-icon]>svg]:me-0 [&_[data-slot=select-icon]>svg]:size-4 [&_[data-slot=select-icon]>svg]:text-muted-foreground [&_[data-slot=select-icon]>svg]:opacity-100`;

export const THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS = `h-8 w-full min-w-0 justify-start rounded-lg border border-transparent ${THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS} text-[13px] font-medium text-foreground/80 sm:h-8 sm:text-[13px]`;

export const THREAD_DETAILS_PANEL_ICON_CLASS = "size-4 shrink-0 text-muted-foreground";

export const THREAD_DETAILS_PANEL_CHEVRON_CLASS = "size-4 shrink-0 text-muted-foreground";

export const THREAD_DETAILS_PANEL_ICON_ACTION_CLASS = `size-6 justify-center rounded-md border-transparent bg-transparent p-0 sm:size-6 ${THREAD_DETAILS_PANEL_ROW_SURFACE_CLASS}`;

/** A small text control on a row's second line, such as a pull request's checks or next action. */
export const THREAD_DETAILS_PANEL_META_ACTION_CLASS = `h-6 gap-1 rounded-md border-transparent px-1.5 text-xs font-medium text-muted-foreground ${THREAD_DETAILS_PANEL_ROW_SURFACE_CLASS}`;

export const THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS = `flex w-full items-center rounded-lg ${THREAD_DETAILS_PANEL_SPLIT_GROUP_SURFACE_CLASS}`;

export const THREAD_DETAILS_PANEL_SPLIT_PRIMARY_CLASS = `${THREAD_DETAILS_PANEL_CONTROL_CLASS} flex-1 justify-start rounded-e-none ${THREAD_DETAILS_PANEL_SPLIT_BUTTON_SURFACE_CLASS}`;

export const THREAD_DETAILS_PANEL_SPLIT_SECONDARY_CLASS = `${THREAD_DETAILS_PANEL_CONTROL_CLASS} w-8 justify-center rounded-s-none px-0 ${THREAD_DETAILS_PANEL_SPLIT_BUTTON_SURFACE_CLASS}`;

export const THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS = "h-4 w-px shrink-0 bg-border/65";
