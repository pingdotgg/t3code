export const COMPOSER_INLINE_CHIP_CLASS_NAME =
  "inline-flex max-w-full select-none items-center gap-1 rounded-md border border-border/70 bg-accent/40 px-1.5 py-px font-medium text-[12px] leading-[1.1] text-foreground align-middle";

export const COMPOSER_INLINE_CHIP_ICON_CLASS_NAME = "size-3.5 shrink-0 opacity-85";

export const COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME =
  "block min-w-0 truncate select-none self-center leading-tight";

export const SKILL_CHIP_ICON_SVG = `<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>`;

/**
 * Skill mention pill. Mirrors upstream's ContextChip kind="skill": em-based
 * metrics so the chip scales with the composer's font size, with the svg
 * sized from the chip's font size instead of fixed pixels.
 */
export const COMPOSER_INLINE_SKILL_CHIP_CLASS_NAME =
  "inline-flex h-[1.41em] max-w-full select-none items-center gap-[0.33em] rounded-[0.5em] border border-fuchsia-500/25 bg-fuchsia-500/12 px-[0.5em] align-middle font-medium text-[0.86em] leading-none text-fuchsia-700 dark:text-fuchsia-300 [&_svg]:block [&_svg]:size-[1.17em] [&_svg]:shrink-0 [&_svg]:self-center";

export const COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME =
  "ml-0.5 inline-flex size-3.5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground/72 transition-colors hover:bg-foreground/6 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
