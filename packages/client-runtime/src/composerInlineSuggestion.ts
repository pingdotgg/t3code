export interface ComposerInlineSuggestionCandidate {
  readonly label: string;
}

export interface ComposerInlineSuggestion<T extends ComposerInlineSuggestionCandidate> {
  readonly candidate: T;
  /** The text before the caret that the suggestion replaces. */
  readonly typed: string;
  /** What the caret is followed by: the rest of the label, or the label when `typed` ends it. */
  readonly remainder: string;
}

// Under three letters, ordinary words like "he" or "ma" would keep suggesting names.
const MIN_TYPED_LENGTH = 3;
// Enough for the longest label a user would type out: "Hetzner VPS", "Claude Opus 5.5".
const MAX_TYPED_WORDS = 4;
const WORD_BOUNDARY = /[\s([{"'`]/u;
const LABEL_WORD_BOUNDARY = /[\s\-_/]/u;

function typedRunStarts(line: string): number[] {
  const starts: number[] = [];
  for (let index = line.length - 1; index >= 0; index -= 1) {
    if (index > 0 && !WORD_BOUNDARY.test(line[index - 1] ?? "")) continue;
    if (WORD_BOUNDARY.test(line[index] ?? "")) continue;
    starts.push(index);
    if (starts.length === MAX_TYPED_WORDS) break;
  }
  return starts.reverse();
}

function labelWordMatch(label: string, typed: string): number {
  for (let index = 0; index + typed.length <= label.length; index += 1) {
    if (index > 0 && !LABEL_WORD_BOUNDARY.test(label[index - 1] ?? "")) continue;
    if (label.startsWith(typed, index)) return index;
  }
  return -1;
}

/**
 * The name the user is typing, for the composer's ghost text. The longest run of words before
 * the caret wins, then the earliest candidate. A run can start at any word of a label, so "opus"
 * finds "Claude Opus 5.5". Commands and `@` mentions have their own menus, so they stay out.
 */
export function matchComposerInlineSuggestion<T extends ComposerInlineSuggestionCandidate>(
  textBeforeCaret: string,
  candidates: ReadonlyArray<T>,
): ComposerInlineSuggestion<T> | null {
  const line = textBeforeCaret.slice(textBeforeCaret.lastIndexOf("\n") + 1);
  if (line.startsWith("/") || line.length === 0 || /\s$/u.test(line)) return null;
  for (const start of typedRunStarts(line)) {
    const typed = line.slice(start);
    if (typed.length < MIN_TYPED_LENGTH || !/^\p{L}/u.test(typed)) continue;
    const folded = typed.toLowerCase();
    for (const candidate of candidates) {
      const label = candidate.label.toLowerCase();
      const index = labelWordMatch(label, folded);
      if (index >= 0) {
        const rest = candidate.label.slice(index + typed.length);
        return {
          candidate,
          typed,
          remainder: rest === "" && index > 0 ? ` (${candidate.label})` : rest,
        };
      }
    }
  }
  return null;
}
