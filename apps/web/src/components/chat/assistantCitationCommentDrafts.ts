import type { AssistantCitation } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";

/**
 * Unsaved citation comments, keyed by the serialized citation. The comment
 * editor lives inside the composer's citation node view, and the editor
 * replaces its whole document when a provider question borrows it for the
 * answer, which unmounts the node view without any dismissal. The draft is
 * kept here across that, and dropped once it is saved or discarded.
 */
const drafts = new Map<string, string>();

/**
 * The key a citation's draft lives under. The composer rebuilds its document
 * from the prompt text whenever its value changes, and every node gets a fresh
 * random key then, so the key cannot be the node's. Two identical citations
 * still need separate drafts, so the serialized citation is suffixed with how
 * many identical ones come before it; a rebuild from the same prompt keeps
 * that order, and so keeps the key.
 */
export function assistantCitationDraftKey(
  citation: AssistantCitation,
  citationsBefore: ReadonlyArray<AssistantCitation>,
  /** The composer the draft belongs to, so another thread's composer never resumes it. */
  scope = "",
): string {
  const serialized = serializeAssistantCitation(citation);
  let ordinal = 0;
  for (const earlier of citationsBefore) {
    if (serializeAssistantCitation(earlier) === serialized) ordinal += 1;
  }
  return `${scope}\n${serialized}#${ordinal}`;
}

export function readAssistantCitationCommentDraft(key: string): string | null {
  return drafts.get(key) ?? null;
}

export function writeAssistantCitationCommentDraft(key: string, draft: string): void {
  drafts.set(key, draft);
}

export function clearAssistantCitationCommentDraft(key: string): void {
  drafts.delete(key);
}

export type AssistantCitationCommentDraftEntries = ReadonlyArray<
  readonly [key: string, draft: string]
>;

/**
 * Takes every draft a composer still holds once its prompt has been sent. A
 * popover that stayed open through the send (a comment over the length limit
 * keeps it open) would otherwise hand its text to the next prompt that cites
 * the same text in the same composer. A send that fails gives the prompt back
 * and restores these with it.
 */
export function takeAssistantCitationCommentDraftsForComposer(
  scope: string,
): AssistantCitationCommentDraftEntries {
  const prefix = `${scope}\n`;
  const taken: Array<readonly [string, string]> = [];
  for (const [key, draft] of drafts) {
    if (!key.startsWith(prefix)) continue;
    taken.push([key, draft]);
    drafts.delete(key);
  }
  return taken;
}

export function restoreAssistantCitationCommentDrafts(
  entries: AssistantCitationCommentDraftEntries,
): void {
  for (const [key, draft] of entries) drafts.set(key, draft);
}
