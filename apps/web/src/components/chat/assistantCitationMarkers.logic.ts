import { AssistantCitation } from "@t3tools/contracts";
import type { JSONContent } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import * as Schema from "effect/Schema";

const isCitation = Schema.is(AssistantCitation);

export function draftCitationMarkers(doc: JSONContent) {
  const citations: {
    citation: AssistantCitation;
    key: string;
    number: number;
  }[] = [];
  const occurrences = new Map<string, number>();
  const visit = (node: JSONContent) => {
    const citation: unknown = node.attrs?.citation;
    if (node.type === "composer-citation" && isCitation(citation)) {
      const key = nextCitationMarkerKey(citation, occurrences);
      citations.push({
        citation,
        key,
        number: citations.length + 1,
      });
    }
    for (const child of node.content ?? []) visit(child);
  };
  visit(doc);
  return citations;
}

function nextCitationMarkerKey(citation: AssistantCitation, occurrences: Map<string, number>) {
  const identity = JSON.stringify([
    citation.environmentId,
    citation.threadId,
    citation.messageId,
    citation.start,
    citation.end,
  ]);
  const occurrence = occurrences.get(identity) ?? 0;
  occurrences.set(identity, occurrence + 1);
  return `${identity}:${occurrence}`;
}

export function composerCitationMarker(doc: Node, citeKey: string) {
  const occurrences = new Map<string, number>();
  let number = 0;
  let marker: string | undefined;
  const visit = (node: Node): boolean => {
    const citation: unknown = node.attrs.citation;
    if (node.type.name === "composer-citation" && isCitation(citation)) {
      const key = nextCitationMarkerKey(citation, occurrences);
      number++;
      if (node.attrs.citeKey === citeKey) {
        marker = `${number}|${key}`;
        return true;
      }
    }
    for (let index = 0; index < node.childCount; index++) {
      if (visit(node.child(index))) return true;
    }
    return false;
  };
  visit(doc);
  return marker;
}
