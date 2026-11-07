import { AssistantCitation } from "@t3tools/contracts";
import type { JSONContent } from "@tiptap/core";
import * as Schema from "effect/Schema";

const isCitation = Schema.is(AssistantCitation);

export function draftCitationMarkers(doc: JSONContent, includeNodeKeys = false) {
  const citations: {
    citation: AssistantCitation;
    key: string;
    number: number;
    nodeKey?: string;
  }[] = [];
  const occurrences = new Map<string, number>();
  const visit = (node: JSONContent) => {
    const citation: unknown = node.attrs?.citation;
    if (node.type === "composer-citation" && isCitation(citation)) {
      const identity = JSON.stringify([
        citation.environmentId,
        citation.threadId,
        citation.messageId,
        citation.start,
        citation.end,
      ]);
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      citations.push({
        citation,
        key: `${identity}:${occurrence}`,
        number: citations.length + 1,
        ...(includeNodeKeys && typeof node.attrs?.citeKey === "string"
          ? { nodeKey: node.attrs.citeKey }
          : {}),
      });
    }
    for (const child of node.content ?? []) visit(child);
  };
  visit(doc);
  return citations;
}
