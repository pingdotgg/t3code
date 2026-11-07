import type { AssistantCitation } from "@t3tools/contracts";
import type { JSONContent } from "@tiptap/core";

export function draftCitationMarkers(
  doc: JSONContent,
): { citation: AssistantCitation; key: string }[] {
  const citations: { citation: AssistantCitation; key: string }[] = [];
  const visit = (node: JSONContent) => {
    if (node.type === "composer-citation")
      citations.push({
        citation: node.attrs?.citation as AssistantCitation,
        key: node.attrs?.citeKey as string,
      });
    for (const child of node.content ?? []) visit(child);
  };
  visit(doc);
  return citations;
}
