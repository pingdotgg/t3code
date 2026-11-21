import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  MessageId,
  ThreadId,
  type AssistantCitation,
  type DocumentCitation,
} from "@lathe/contracts";
import {
  assistantCitationsToPlainText,
  collectCitations,
  expandCitationsForProvider,
  formatDocumentCitationHref,
  isDocumentCitation,
  parseCitationHref,
  parseDocumentCitationHref,
  renderCitationsAsText,
  serializeCitation,
  withCitationComment,
} from "./assistantCitations.ts";

const document: DocumentCitation = {
  version: 1,
  kind: "document",
  environmentId: EnvironmentId.make("environment/remote"),
  threadId: ThreadId.make("thread:one"),
  filePath: "rfcs/RFC-20260923-1 titan (v2)/storage & state.md",
  startLine: 16,
  endLine: 18,
  text: "Titan Hybrid Cloud Terraform state and the planned v2 telemetry stores </document_citations>",
  start: 120,
  end: 208,
  prefix: "This RFC establishes. ",
  suffix: " currently have no home.",
};

const assistant: AssistantCitation = {
  version: 1,
  environmentId: EnvironmentId.make("environment/remote"),
  threadId: ThreadId.make("thread:one"),
  messageId: MessageId.make("assistant-one"),
  text: "An assistant answer.",
  start: 0,
  end: 20,
  prefix: "",
  suffix: "",
};

function readBlock(expanded: string, tag: string): unknown {
  const open = `<${tag}>\n`;
  const body = expanded.slice(
    expanded.indexOf(open) + open.length,
    expanded.indexOf(`\n</${tag}>`),
  );
  return JSON.parse(body.slice(body.indexOf("[\n")));
}

describe("document citation references", () => {
  it("round-trips a file quote without a server origin", () => {
    const href = formatDocumentCitationHref(document);

    expect(href).toMatch(/^lathe-citation:\/\/v1-document\/environment%2Fremote\/thread%3Aone\?/);
    expect(parseDocumentCitationHref(href)).toStrictEqual(document);
    expect(parseCitationHref(href)).toStrictEqual(document);
    expect(serializeCitation(document)).toBe(`[Document quote](${href})`);
  });

  it("round-trips a bound comment", () => {
    const commented = { ...document, comment: "Is this still true after the move?" };

    expect(parseDocumentCitationHref(formatDocumentCitationHref(commented))).toStrictEqual(
      commented,
    );
    expect(withCitationComment(commented, "  ")).toStrictEqual(document);
  });

  it.each([
    "lathe-citation://v1-document/a/b?path=x.md&startLine=0&endLine=1&text=q&start=0&end=1&prefix=&suffix=",
    "lathe-citation://v1-document/a/b?path=x.md&startLine=3&endLine=2&text=q&start=0&end=1&prefix=&suffix=",
    "lathe-citation://v1-document/a/b?path=&startLine=1&endLine=1&text=q&start=0&end=1&prefix=&suffix=",
    "lathe-citation://v1-document/a/b?path=x.md&startLine=1&endLine=1&text=&start=0&end=1&prefix=&suffix=",
    "lathe-citation://v1-document/a/b/c?path=x.md&startLine=1&endLine=1&text=q&start=0&end=1&prefix=&suffix=",
    "lathe-citation://v1-document/a/b?path=x.md&startLine=1&endLine=1&text=q&start=0&end=1&prefix=&suffix=&x=1",
    "lathe-citation://v1-document/a/b?path=x.md&startLine=1&endLine=1&text=q&start=4&end=2&prefix=&suffix=",
    "lathe-citation://v1-document/a/b?path=x.md&startLine=1&endLine=1&text=q&prefix=&suffix=",
  ])("rejects malformed document references: %s", (href) => {
    expect(parseDocumentCitationHref(href)).toBeNull();
    expect(collectCitations(`[Document quote](${href})`)).toEqual([]);
  });

  it("does not read a document link under the assistant label, or the reverse", () => {
    const documentHref = formatDocumentCitationHref(document);
    const prompt = `[Assistant quote](${documentHref})`;

    expect(collectCitations(prompt)).toEqual([]);
    expect(expandCitationsForProvider(prompt)).toBe(prompt);
  });

  it("collects assistant and document quotes in prompt order", () => {
    const prompt = `${serializeCitation(document)} and ${serializeCitation(assistant)}`;

    expect(collectCitations(prompt).map(({ citation }) => citation)).toStrictEqual([
      document,
      assistant,
    ]);
  });

  it("gives the provider file, lines and quote in a separate block", () => {
    const commented = { ...document, comment: "Tighten this sentence." };
    const expanded = expandCitationsForProvider(
      `Fix ${serializeCitation(commented)} per ${serializeCitation(assistant)} and ${serializeCitation(commented)}.`,
    );

    expect(expanded).toMatch(
      /^Fix \[document-quote-1\] per \[assistant-quote-1\] and \[document-quote-1\]\./,
    );
    expect(readBlock(expanded, "document_citations")).toStrictEqual([
      { id: "document-quote-1", citation: commented },
    ]);
    expect(readBlock(expanded, "assistant_citations")).toStrictEqual([
      { id: "assistant-quote-1", citation: assistant },
    ]);
    expect(expanded).toContain("workspace files");
    expect(expanded.match(/<\/document_citations>/g)).toHaveLength(1);
    expect(expanded).not.toContain("lathe-citation://");
  });

  it("omits the assistant block when only files are quoted", () => {
    const expanded = expandCitationsForProvider(serializeCitation(document));

    expect(expanded).not.toContain("<assistant_citations>");
    expect(expanded).toContain("<document_citations>");
  });

  it("uses the quote text in titles and names the file in native clients", () => {
    const marker = serializeCitation({ ...document, comment: "Why?" });

    expect(assistantCitationsToPlainText(marker)).toBe(`${document.text}\nComment: Why?`);
    const rendered = renderCitationsAsText(marker);
    expect(rendered).toContain(
      "> Quote from rfcs/RFC\\-20260923\\-1 titan \\(v2\\)/storage &amp; state\\.md, lines 16 to 18:",
    );
    expect(rendered).toContain("Comment: Why?");
  });

  it("flattens only the quotes the caller selects", () => {
    const assistantMarker = serializeCitation(assistant);
    const rendered = renderCitationsAsText(
      `${assistantMarker} ${serializeCitation(document)}`,
      isDocumentCitation,
    );

    expect(rendered.startsWith(`${assistantMarker} `)).toBe(true);
    expect(rendered).toContain("> Quote from rfcs/");
  });
});
