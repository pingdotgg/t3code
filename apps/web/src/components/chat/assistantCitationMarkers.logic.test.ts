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
  expect(draftCitationMarkers(buildDocJson("plain text", () => null))).toEqual([]);
  expect(draftCitationMarkers(buildDocJson(`\`\`\`text\n${link}\n\`\`\``, () => null))).toEqual([]);
});
