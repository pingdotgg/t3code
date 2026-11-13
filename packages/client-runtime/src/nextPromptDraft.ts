// Custom build: next-prompt buttons add to the composer instead of replacing it, so several
// can be picked. Each pick is its own paragraph; picking one again takes it back out.

// "\r" counts as blank so pasted Windows line endings still separate paragraphs.
const isBlank = (char: string | undefined) => char === " " || char === "\t" || char === "\r";

// A pick starts the draft or follows a blank line. Checked locally, so typing stays linear.
function startsParagraph(draft: string, at: number): boolean {
  let i = at;
  while (isBlank(draft[i - 1])) i--;
  if (i === 0) return true;
  if (draft[i - 1] !== "\n") return false;
  i--;
  while (isBlank(draft[i - 1])) i--;
  return i === 0 || draft[i - 1] === "\n";
}

/** Where a pick ending at `end` stops, past its trailing spaces, or -1 mid-paragraph. */
function paragraphEnd(draft: string, end: number): number {
  let j = end;
  while (isBlank(draft[j])) j++;
  if (j === draft.length) return j;
  if (draft[j] !== "\n") return -1;
  let k = j + 1;
  while (isBlank(draft[k])) k++;
  return k === draft.length || draft[k] === "\n" ? j : -1;
}

interface Pick {
  readonly start: number;
  readonly end: number;
}

function findPick(draft: string, insertText: string): Pick | null {
  const target = insertText.trim();
  if (target.length === 0) return null;
  for (let at = draft.indexOf(target); at !== -1; at = draft.indexOf(target, at + 1)) {
    if (!startsParagraph(draft, at)) continue;
    const end = paragraphEnd(draft, at + target.length);
    if (end !== -1) return { start: at, end };
  }
  return null;
}

/** Whether the suggestion is in the draft as its own paragraph, as a pick leaves it. */
export function isNextPromptInDraft(draft: string, insertText: string): boolean {
  return findPick(draft, insertText) !== null;
}

const LEADING_BLANK_LINES = /^(?:[ \t\r]*\n)+/;

/** Adds text as its own paragraph: an empty box gets it alone, other text gets a blank line first. */
export function appendParagraphToDraft(draft: string, text: string): string {
  return draft.trim().length === 0 ? text : `${draft.trimEnd()}\n\n${text}`;
}

/**
 * The draft after a click on a suggestion: an empty box gets the suggestion, other text gets it
 * after a blank line, and a suggestion already there as its own paragraph is removed. A slash
 * command goes first instead, since providers run one only at the start of a message.
 */
export function toggleNextPromptInDraft(
  draft: string,
  insertText: string,
  options?: { readonly leading?: boolean },
): string {
  const pick = findPick(draft, insertText);
  if (pick === null) {
    if (draft.trim().length === 0) return insertText;
    return options?.leading === true
      ? `${insertText.trimEnd()}\n\n${draft.replace(LEADING_BLANK_LINES, "")}`
      : appendParagraphToDraft(draft, insertText);
  }
  const before = draft.slice(0, pick.start);
  const after = draft.slice(pick.end);
  // First paragraph: drop the blank lines after it, but keep the next paragraph's indentation.
  if (before.trim().length === 0) return after.replace(LEADING_BLANK_LINES, "");
  // Drop only the break before it, keeping the person's trailing spaces (a Markdown line break).
  return before.replace(/\r?\n[ \t\r\n]*$/, "") + after;
}
