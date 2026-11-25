import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, MessageId, ThreadId } from "@lathe/contracts";
import type { Element, Root } from "hast";

import {
  collectCitations,
  formatAssistantCitationHref,
  parseCitationHref,
} from "./assistantCitations.ts";
import {
  collectComposerContextReferences,
  parseComposerContextHref,
} from "./composerContextReferences.ts";
import { latheLinkHref } from "./forkLegacyLinks.ts";
import { sanitizeChatHast } from "./markdownHast.ts";
import { hasThreadLinks, parseThreadLinkHref } from "./threadLinks.ts";

describe("latheLinkHref", () => {
  it.each([
    ["t3-citation://v1/x", "lathe-citation://v1/x"],
    ["t3-thread://v1/thread-1", "lathe-thread://v1/thread-1"],
    ["t3-context://v1/file/a", "lathe-context://v1/file/a"],
    ["lathe-thread://v1/thread-1", "lathe-thread://v1/thread-1"],
    ["https://example.com/t3-thread://", "https://example.com/t3-thread://"],
  ])("reads %s as %s", (href, expected) => {
    expect(latheLinkHref(href)).toBe(expected);
  });
});

describe("links stored before the Lathe rename", () => {
  it("parses a thread link", () => {
    expect(parseThreadLinkHref("t3-thread://v1/thread-1")).toEqual({
      environmentId: null,
      threadId: "thread-1",
    });
    expect(hasThreadLinks("See [it](t3-thread://v1/thread-1).")).toBe(true);
  });

  it("parses a composer context link, in an href and in text", () => {
    expect(parseComposerContextHref("t3-context://v1/file/notes")).toEqual(
      parseComposerContextHref("lathe-context://v1/file/notes"),
    );
    expect(
      collectComposerContextReferences("Read [notes](t3-context://v1/file/notes) now"),
    ).toHaveLength(1);
  });

  it("parses a citation link like its Lathe form", () => {
    const citation = {
      version: 1 as const,
      environmentId: EnvironmentId.make("environment"),
      threadId: ThreadId.make("thread"),
      messageId: MessageId.make("message"),
      text: "quoted",
      start: 0,
      end: 6,
      prefix: "",
      suffix: "",
    };
    const legacy = formatAssistantCitationHref(citation).replace(/^lathe-/, "t3-");
    expect(legacy.startsWith("t3-citation://")).toBe(true);
    expect(parseCitationHref(legacy)).toEqual(citation);
    expect(collectCitations(`See [Assistant quote](${legacy}).`)).toHaveLength(1);
  });

  it.each([
    ["a", "href", "t3-citation://v1/x"],
    ["a", "href", "t3-thread://v1/thread-1"],
    ["a", "href", "t3-context://v1/file/notes"],
    ["img", "src", "t3-context://v1/image/shot"],
  ])("keeps a stored <%s %s> under %s through the chat sanitizer", (tagName, property, url) => {
    const tree: Root = {
      type: "root",
      children: [{ type: "element", tagName, properties: { [property]: url }, children: [] }],
    };
    const [element] = sanitizeChatHast(tree).children as Array<Element>;
    expect(element?.properties[property]).toBe(url);
  });
});
