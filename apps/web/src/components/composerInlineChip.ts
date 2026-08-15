// Chip metrics are in em so the pills scale with the text they sit in (the
// composer honors the prompt font-size preference). The chat variant pins the
// original 12px, where every em value resolves to the same pixels as before.
const INLINE_CHIP_CLASS_NAME =
  "inline-flex max-w-full items-center gap-[0.33em] rounded-[0.5em] border border-border/70 bg-accent/40 px-[0.5em] py-[0.08em] font-medium leading-[1.1] text-foreground align-middle";

export const CHAT_INLINE_CHIP_CLASS_NAME = `${INLINE_CHIP_CLASS_NAME} text-[12px]`;

export const COMPOSER_INLINE_CHIP_CLASS_NAME = `${INLINE_CHIP_CLASS_NAME} text-[0.86em] select-none`;

export const COMPOSER_INLINE_CHIP_DECORATOR_CLASS_NAME =
  "relative inline-flex align-[-0.125em] leading-none data-[composer-chip-selected]:after:pointer-events-none data-[composer-chip-selected]:after:absolute data-[composer-chip-selected]:after:inset-0 data-[composer-chip-selected]:after:rounded-[6px] data-[composer-chip-selected]:after:bg-[Highlight] data-[composer-chip-selected]:after:opacity-30 data-[composer-chip-selected]:after:content-['']";

export const COMPOSER_INLINE_CHIP_ICON_CLASS_NAME = "size-[1.17em] shrink-0 opacity-85";

export const CHAT_INLINE_CHIP_LABEL_CLASS_NAME = "truncate leading-tight";

export const COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME = `${CHAT_INLINE_CHIP_LABEL_CLASS_NAME} select-none`;

// The skill label is smaller than the surrounding prompt text; offset its
// glyphs without moving the pill box or changing the editor's line height.
export const COMPOSER_INLINE_SKILL_CHIP_LABEL_CLASS_NAME = `${COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME} relative top-[0.15em]`;

export const COMPOSER_INLINE_SKILL_CHIP_CLASS_NAME =
  "inline-flex max-w-full select-none items-center gap-[0.33em] rounded-[0.5em] border border-fuchsia-500/25 bg-fuchsia-500/12 px-[0.5em] py-[0.08em] font-medium text-[0.86em] leading-[1.1] text-fuchsia-700 align-middle dark:text-fuchsia-300";

export const SKILL_CHIP_ICON_SVG = `<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>`;

export const COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME =
  "ml-[0.17em] inline-flex size-[1.17em] shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground/72 transition-colors hover:bg-foreground/6 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
