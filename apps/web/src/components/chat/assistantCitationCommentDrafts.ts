import type { AssistantCitation } from "@t3tools/contracts";
import {
  collectAssistantCitations,
  serializeAssistantCitation,
  withAssistantCitationComment,
} from "@t3tools/shared/assistantCitations";

import { resolveAssistantCitationCommentDismissal } from "./assistantCitationCommentDismissal";

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

/**
 * Writes a composer's unsaved comments onto their citations in the prompt, the
 * way dismissing the popover would have. Called when a question or an approval
 * borrows the prompt editor: its chips unmount without a dismissal, and
 * without this they would come back uncommented and Send would leave the
 * comment out. A draft the dismissal rules would not commit (over the length
 * limit) stays a draft and is resumed when its popover is opened again.
 */
export function commitAssistantCitationCommentDrafts(prompt: string, scope: string): string {
  const citations = collectAssistantCitations(prompt);
  // Keys are read off the prompt as it is: committing one comment changes that
  // citation's serialized form, which the later duplicates' ordinals count.
  const keys = citations.map((entry, index) =>
    assistantCitationDraftKey(
      entry.citation,
      citations.slice(0, index).map((earlier) => earlier.citation),
      scope,
    ),
  );
  let committed = prompt;
  for (let index = citations.length - 1; index >= 0; index -= 1) {
    const { citation, start, end } = citations[index]!;
    const key = keys[index]!;
    const draft = drafts.get(key);
    if (draft === undefined) continue;
    const dismissal = resolveAssistantCitationCommentDismissal({
      reason: "none",
      draft,
      savedComment: citation.comment,
    });
    if (dismissal.kind === "keep-open") continue;
    drafts.delete(key);
    if (dismissal.kind !== "commit") continue;
    committed =
      committed.slice(0, start) +
      serializeAssistantCitation(withAssistantCitationComment(citation, dismissal.comment)) +
      committed.slice(end);
  }
  return committed;
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
