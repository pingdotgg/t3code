import {
  ASSISTANT_CITATION_MAX_COMMENT_LENGTH,
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  type EnvironmentId,
  type MessageId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  serializeAssistantCitation,
  withAssistantCitationComment,
} from "@t3tools/shared/assistantCitations";

import * as Dialog from "../../components/ui/Dialog";
import { scopedThreadKey } from "../../lib/scopedEntities";
import {
  captureComposerDraftInsertion,
  insertComposerDraftText,
} from "../../state/use-composer-drafts";

export function citeAssistantText(
  source: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  },
  selection: { readonly text: string; readonly start: number },
): void {
  const { text } = selection;
  if (!text.trim()) return;
  if (text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH) {
    Dialog.alert("Selection is too long to cite", "Select a shorter passage and try again.");
    return;
  }
  const draftKey = scopedThreadKey(source.environmentId, source.threadId);
  const insertion = captureComposerDraftInsertion(draftKey);
  const start = Math.max(0, selection.start);
  // Native offsets are per rendered block, not per message, and carry no surrounding context;
  // web resolves the quote by its text when the offsets do not line up.
  const citation = {
    version: 1 as const,
    ...source,
    text,
    start,
    end: start + text.replace(/\s+/g, " ").length,
    prefix: "",
    suffix: "",
  };
  Dialog.prompt({
    title: "Cite",
    message: "Add a comment about this quote (optional).",
    placeholder: "Comment",
    initialValue: "",
    confirmText: "Cite",
    onConfirm: (comment) => {
      if (comment.trim().length > ASSISTANT_CITATION_MAX_COMMENT_LENGTH) {
        Dialog.alert("Comment is too long", "Shorten the comment and cite again.");
        return;
      }
      const before = insertion.text.slice(0, insertion.start);
      const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
      insertComposerDraftText(
        draftKey,
        `${lead}${serializeAssistantCitation(withAssistantCitationComment(citation, comment))} `,
        insertion,
      );
    },
  });
}
