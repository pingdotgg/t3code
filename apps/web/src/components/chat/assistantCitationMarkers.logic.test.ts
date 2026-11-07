import type { JSONContent } from "@tiptap/core";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { buildDocJson } from "~/composer-rich-text-doc";
import { draftCitationMarkers } from "./assistantCitationMarkers.logic";

it("numbers only citation nodes in document order, including repeated sources", () => {
  const citation = {
    version: 1 as const,
    environmentId: EnvironmentId.make("env"),
    threadId: ThreadId.make("thread"),
    messageId: MessageId.make("message"),
    text: "hello",
    start: 0,
    end: 5,
    prefix: "",
    suffix: "",
  };
  const second = { ...citation, text: "world", start: 6, end: 11 };
  const link = serializeAssistantCitation(citation);
  const doc = buildDocJson(`${serializeAssistantCitation(second)} ${link} ${link}`, () => null);
  expect(draftCitationMarkers(doc).map((marker) => marker.citation)).toEqual([
    second,
    citation,
    citation,
  ]);
  const markers = draftCitationMarkers(doc);
  const composerDoc = structuredClone(doc);
  let nodeIndex = 0;
  const assignKeys = (node: JSONContent) => {
    if (node.type === "composer-citation")
      node.attrs = { ...node.attrs, citeKey: `chip-${nodeIndex++}` };
    for (const child of node.content ?? []) assignKeys(child);
  };
  assignKeys(composerDoc);
  const chips = draftCitationMarkers(composerDoc, true);
  for (const index of [0, 1]) {
    const chip = chips.find((marker) => marker.nodeKey === `chip-${index}`);
    expect(chip?.number).toBe(markers[index]?.number);
    expect(chip?.number).toBe(index + 1);
    expect(chip?.key).toBe(markers[index]?.key);
  }
  expect(new Set(markers.map(({ key }) => key)).size).toBe(3);
  expect(
    draftCitationMarkers(
      buildDocJson(`typing ${serializeAssistantCitation(second)} ${link} ${link} more`, () => null),
    ),
  ).toEqual(markers);
  expect(
    draftCitationMarkers({
      type: "doc",
      content: [
        { type: "composer-citation", attrs: { citation: null } },
        { type: "composer-citation", attrs: { citation: { messageId: "bad" } } },
      ],
    }),
  ).toEqual([]);
  expect(draftCitationMarkers(buildDocJson("plain text", () => null))).toEqual([]);
  expect(draftCitationMarkers(buildDocJson(`\`\`\`text\n${link}\n\`\`\``, () => null))).toEqual([]);
});
