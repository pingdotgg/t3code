import { ASSISTANT_CITATION_MAX_COMMENT_LENGTH } from "@t3tools/contracts";

export type AssistantCitationCommentDismissal =
  | { kind: "commit"; comment: string }
  | { kind: "close" }
  | { kind: "keep-open" };

export function resolveAssistantCitationCommentDismissal({
  reason,
  draft,
  savedComment,
}: {
  reason: string;
  draft: string | null;
  savedComment: string | undefined;
}): AssistantCitationCommentDismissal {
  if (reason === "escape-key" || draft === null) return { kind: "close" };
  if (draft.trim() === (savedComment ?? "").trim()) return { kind: "close" };
  if (draft.length > ASSISTANT_CITATION_MAX_COMMENT_LENGTH) return { kind: "keep-open" };
  return { kind: "commit", comment: draft };
}
