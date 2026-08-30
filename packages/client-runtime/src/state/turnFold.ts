/**
 * Longest assistant message the settled-turn fold treats as narration.
 *
 * A reply is minted as one message per provider stream segment, and a segment
 * closes on every tool call, so one answer routinely arrives as several
 * messages with tool activity between them. Position alone therefore cannot
 * separate narration ("Looking around first.") from a mid-reply chunk of the
 * answer itself — folding every non-terminal message hides most of the reply.
 */
export const FOLDABLE_NARRATION_MAX_CHARS = 240;

/**
 * Whether an assistant message reads as narration the settled-turn fold may
 * hide: one short block with no paragraph break. Longer or multi-paragraph
 * text is part of the reply and stays visible outside the fold.
 */
export function isFoldableAssistantNarration(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length <= FOLDABLE_NARRATION_MAX_CHARS && !/\n[^\S\n]*\n/.test(trimmed);
}
