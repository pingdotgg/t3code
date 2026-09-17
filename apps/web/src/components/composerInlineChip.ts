// Chip metrics are in em so the pills scale with the text they sit in (the
// composer honors the prompt font-size preference). The chat variant pins the
// original 12px, where every em value resolves to the same pixels as before.
const INLINE_CHIP_GEOMETRY_CLASS_NAME =
  "inline-flex h-[1.41em] max-w-full items-center gap-[0.33em] rounded-[0.5em] px-[0.5em] font-medium leading-none align-middle";

const INLINE_CHIP_CLASS_NAME = `${INLINE_CHIP_GEOMETRY_CLASS_NAME} border border-border/70 bg-accent/40 text-foreground`;

const CONTEXT_INLINE_CHIP_TONE_CLASS_NAME =
  "border-[color-mix(in_oklab,var(--context-chip-accent)_34%,var(--contrast-border))] bg-[color-mix(in_oklab,var(--context-chip-accent)_11%,transparent)] text-[color-mix(in_oklab,var(--context-chip-accent)_22%,var(--contrast-foreground))]";

export const CHAT_INLINE_CHIP_CLASS_NAME = `${INLINE_CHIP_CLASS_NAME} text-[12px]`;

export const COMPOSER_INLINE_CHIP_CLASS_NAME = `${INLINE_CHIP_CLASS_NAME} text-[0.86em] select-none`;

export const COMPOSER_INLINE_CHIP_DECORATOR_CLASS_NAME =
  "relative inline-flex items-center align-middle leading-none data-[composer-chip-selected]:after:pointer-events-none data-[composer-chip-selected]:after:absolute data-[composer-chip-selected]:after:inset-0 data-[composer-chip-selected]:after:rounded-[6px] data-[composer-chip-selected]:after:bg-[Highlight] data-[composer-chip-selected]:after:opacity-30 data-[composer-chip-selected]:after:content-['']";

export const COMPOSER_INLINE_CHIP_ICON_CLASS_NAME =
  "block size-[1.17em] shrink-0 self-center [&>svg]:block";

export const CONTEXT_INLINE_CHIP_FOCUS_CLASS_NAME =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--contrast-foreground)]";

export const CONTEXT_INLINE_CHIP_INTERACTIVE_CLASS_NAME = `transition-colors hover:border-[color-mix(in_oklab,var(--context-chip-accent)_48%,var(--contrast-border))] hover:bg-[color-mix(in_oklab,var(--context-chip-accent)_17%,transparent)] motion-reduce:transition-none ${CONTEXT_INLINE_CHIP_FOCUS_CLASS_NAME}`;

export const CONTEXT_INLINE_CHIP_ICON_TONE_CLASS_NAMES = {
  image: "text-current",
  video: "text-current",
  file: "text-current",
  mention: "text-current",
  terminal: "text-current",
  element: "text-current",
  "preview-annotation": "text-current",
  "review-comment": "text-current",
  "pull-request": "text-current",
  skill: "text-current",
  citation: "text-current",
} as const;

/**
 * Context kinds keep one restrained color identity in both composer and sent messages.
 * Every accent shares a lightness so no kind reads heavier than another; only hue carries
 * identity. Chroma is capped, then clamped to what each hue can hold in sRGB, which keeps
 * the set inside the range the themes use for their own accents rather than above it.
 */
export const CONTEXT_INLINE_CHIP_TONE_CLASS_NAMES = {
  image: `${CONTEXT_INLINE_CHIP_TONE_CLASS_NAME} [--context-chip-accent:oklch(0.62_0.16_16)]`,
  video: `${CONTEXT_INLINE_CHIP_TONE_CLASS_NAME} [--context-chip-accent:oklch(0.62_0.16_48)]`,
  file: `${CONTEXT_INLINE_CHIP_TONE_CLASS_NAME} [--context-chip-accent:oklch(0.62_0.136_237)]`,
  mention: `${CONTEXT_INLINE_CHIP_TONE_CLASS_NAME} [--context-chip-accent:oklch(0.62_0.11_215)]`,
  terminal: `${CONTEXT_INLINE_CHIP_TONE_CLASS_NAME} [--context-chip-accent:oklch(0.62_0.134_163)]`,
  element: `${CONTEXT_INLINE_CHIP_TONE_CLASS_NAME} [--context-chip-accent:oklch(0.62_0.134_70)]`,
  "preview-annotation": `${CONTEXT_INLINE_CHIP_TONE_CLASS_NAME} [--context-chip-accent:oklch(0.62_0.134_70)]`,
  "review-comment": `${CONTEXT_INLINE_CHIP_TONE_CLASS_NAME} [--context-chip-accent:oklch(0.62_0.16_292)]`,
  "pull-request": `${CONTEXT_INLINE_CHIP_TONE_CLASS_NAME} [--context-chip-accent:oklch(0.62_0.16_277)]`,
  skill: `${CONTEXT_INLINE_CHIP_TONE_CLASS_NAME} [--context-chip-accent:oklch(0.62_0.16_322)]`,
  citation: `${CONTEXT_INLINE_CHIP_TONE_CLASS_NAME} [--context-chip-accent:oklch(0.62_0.16_259)]`,
} as const;

export const PULL_REQUEST_INLINE_CHIP_TONE_CLASS_NAMES = {
  open: `${CONTEXT_INLINE_CHIP_TONE_CLASS_NAME} [--context-chip-accent:oklch(0.62_0.134_163)]`,
  draft: `${CONTEXT_INLINE_CHIP_TONE_CLASS_NAME} [--context-chip-accent:oklch(0.62_0.02_259)]`,
  merged: `${CONTEXT_INLINE_CHIP_TONE_CLASS_NAME} [--context-chip-accent:oklch(0.62_0.16_292)]`,
  closed: `${CONTEXT_INLINE_CHIP_TONE_CLASS_NAME} [--context-chip-accent:oklch(0.62_0.16_16)]`,
  unknown: CONTEXT_INLINE_CHIP_TONE_CLASS_NAMES["pull-request"],
} as const;

export const CHAT_INLINE_CHIP_LABEL_CLASS_NAME = "truncate leading-tight";

export const COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME =
  "block self-center truncate leading-tight select-none";

export const COMPOSER_INLINE_SKILL_CHIP_CLASS_NAME = `${INLINE_CHIP_GEOMETRY_CLASS_NAME} select-none border text-[0.86em] ${CONTEXT_INLINE_CHIP_TONE_CLASS_NAMES.skill}`;

export const SKILL_CHIP_ICON_SVG = `<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>`;

export const COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME =
  "ml-[0.17em] inline-flex size-[1.17em] shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground/72 transition-colors hover:bg-foreground/6 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** Keeps both the recognizable beginning and the extension/end of a long attachment name. */
export function middleTruncateAttachmentName(name: string, maxCharacters = 36): string {
  const characters = Array.from(name);
  if (characters.length <= maxCharacters) return name;
  if (maxCharacters <= 0) return "";
  if (maxCharacters === 1) return "…";
  const available = maxCharacters - 1;
  const suffixLength = Math.min(available - 1, available >= 18 ? 14 : Math.ceil(available / 2));
  const prefixLength = available - suffixLength;
  const suffix = suffixLength === 0 ? "" : characters.slice(-suffixLength).join("");
  return `${characters.slice(0, prefixLength).join("")}…${suffix}`;
}
