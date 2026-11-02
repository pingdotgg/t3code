export const CONTEXT_CHIP_ACCENTS = {
  image: "oklch(0.62 0.136 237)",
  video: "oklch(0.62 0.16 48)",
  file: "oklch(0.62 0.136 237)",
  mention: "oklch(0.62 0.11 215)",
  terminal: "oklch(0.62 0.134 163)",
  element: "oklch(0.62 0.134 70)",
  "preview-annotation": "oklch(0.62 0.134 70)",
  "review-comment": "oklch(0.62 0.16 292)",
  "pull-request": "oklch(0.62 0.16 277)",
  "pr-open": "oklch(0.62 0.134 163)",
  "pr-draft": "oklch(0.62 0.02 259)",
  "pr-merged": "oklch(0.62 0.16 292)",
  "pr-closed": "oklch(0.62 0.16 16)",
  skill: "oklch(0.62 0.16 322)",
  thread: "oklch(0.62 0.12 190)",
  environment: "oklch(0.62 0.11 145)",
  citation: "oklch(0.62 0.16 259)",
  "doc-pdf": "oklch(0.62 0.16 24)",
  "doc-word": "oklch(0.62 0.136 248)",
  "doc-spreadsheet": "oklch(0.62 0.134 148)",
  "doc-slides": "oklch(0.62 0.134 56)",
  "doc-epub": "oklch(0.62 0.16 291)",
} as const;

export type ContextChipAccentKind = keyof typeof CONTEXT_CHIP_ACCENTS;

export function contextChipColorVariable(kind: ContextChipAccentKind): string {
  return `--context-chip-${kind}`;
}
