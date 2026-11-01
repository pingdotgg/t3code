import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";

import {
  formatThreadLink,
  guessThreadLinkRef,
  parseThreadLinkHref,
  relabelThreadLinks,
  threadLinkCandidates,
  threadLinkRefs,
} from "./threadLinks.ts";

const ref = (environmentId: string, threadId = "chat-1") => ({
  environmentId: EnvironmentId.make(environmentId),
  threadId: ThreadId.make(threadId),
});
const v1 = (threadId: string) => ({ environmentId: null, threadId: ThreadId.make(threadId) });
const local = EnvironmentId.make("local");
const titlesIn =
  (titles: Record<string, Record<string, string>>) =>
  ({ environmentId, threadId }: ScopedThreadRef) =>
    titles[environmentId]?.[threadId];

describe("thread link destinations", () => {
  it("names a v1 link's thread in the message's environment, as written and then decoded", () => {
    expect(threadLinkCandidates(v1("provider%3A1"), local)).toEqual([
      ref("local", "provider%3A1"),
      ref("local", "provider:1"),
    ]);
  });

  it("opens the unique matching chat in another environment for a v1 link", () => {
    const destination = ref("remote");
    expect(guessThreadLinkRef(v1("chat-1"), [ref("local", "other-chat"), destination])).toEqual(
      destination,
    );
  });

  it("opens a v2 link only in its own environment", () => {
    const there = ref("there", "a%3A1");
    expect(threadLinkCandidates(there, local)).toEqual([there, ref("there", "a:1")]);
    expect(guessThreadLinkRef(there, [ref("elsewhere", "a%3A1"), ref("elsewhere", "a:1")])).toBe(
      null,
    );
  });

  it("leaves ambiguous or missing destinations unresolved", () => {
    const link = v1("provider%3A1");
    const literal = ref("remote", "provider%3A1");
    const decoded = ref("remote", "provider:1");
    expect(
      guessThreadLinkRef(link, [literal, ref("other-remote", literal.threadId), decoded]),
    ).toBeNull();
    expect(guessThreadLinkRef(link, [decoded, ref("other-remote", decoded.threadId)])).toBeNull();
    expect(guessThreadLinkRef(link, [ref("remote", "other-chat")])).toBeNull();
  });
});

describe("thread links", () => {
  it("takes the ids verbatim, percent escapes included", () => {
    expect(parseThreadLinkHref("t3-thread://v1/mcp:1234")).toEqual(v1("mcp:1234"));
    expect(parseThreadLinkHref("t3-thread://v1/thread:delegated-task:mcp%3A1")).toEqual(
      v1("thread:delegated-task:mcp%3A1"),
    );
    expect(parseThreadLinkHref("t3-thread://v2/env-1/thread:a/b%3A1")).toEqual(
      ref("env-1", "thread:a/b%3A1"),
    );
  });

  it("rejects other links and an empty id", () => {
    expect(parseThreadLinkHref("https://t3.codes")).toBeNull();
    expect(parseThreadLinkHref("t3-thread://v1/")).toBeNull();
    expect(parseThreadLinkHref("t3-thread://v1/ ")).toBeNull();
    expect(parseThreadLinkHref("t3-thread://v2/env-1")).toBeNull();
    expect(parseThreadLinkHref("t3-thread://v2/env-1/")).toBeNull();
    expect(parseThreadLinkHref("t3-thread://v2//chat-1")).toBeNull();
  });

  it("resolves a percent-encoded id when the id as written names no thread", () => {
    const title = titlesIn({ local: { "thread:project:1": "Decoded", "provider%3A1": "Literal" } });
    expect(
      relabelThreadLinks(
        "[a](t3-thread://v1/thread%3Aproject%3A1) [b](t3-thread://v1/provider%3A1)",
        local,
        title,
      ),
    ).toBe("[Decoded](t3-thread://v1/thread:project:1) [Literal](t3-thread://v1/provider%3A1)");
    const untitled = titlesIn({ local: { "a%3A1": "", "a:1": "Other" } });
    expect(relabelThreadLinks("[Kept](t3-thread://v1/a%3A1)", local, untitled)).toBe(
      "[Kept](t3-thread://v1/a%3A1)",
    );
  });

  it("titles a v2 link from its own environment and writes it with that title", () => {
    const title = titlesIn({ local: { t1: "Here" }, there: { t1: "There" } });
    expect(
      relabelThreadLinks(
        "<t3-thread://v2/there/t1> and [old](t3-thread://v2/local/t1)",
        local,
        title,
      ),
    ).toBe("[There](t3-thread://v2/there/t1) and [Here](t3-thread://v2/local/t1)");
  });

  it("turns a v2 link it cannot resolve into plain text, never the raw link", () => {
    expect(
      relabelThreadLinks(
        "<t3-thread://v2/there/t1>, <t3-thread://v2/local/t1>, [Old title](t3-thread://v2/there/t1)",
        local,
        () => undefined,
      ),
    ).toBe("Thread on another machine, Thread no longer available, Old title");
    expect(relabelThreadLinks("[Old](t3-thread://v1/t1)", local, () => undefined)).toBe(
      "[Old](t3-thread://v1/t1)",
    );
  });

  it("leaves links inside code spans and fences as written", () => {
    const markdown = [
      "Live [old](t3-thread://v1/t1), literal `[old](t3-thread://v1/t1)`.",
      "```md",
      "<t3-thread://v2/local/t1>",
      "```",
      "After <t3-thread://v2/local/t1>",
    ].join("\n");
    expect(relabelThreadLinks(markdown, local, () => "New")).toBe(
      [
        "Live [New](t3-thread://v1/t1), literal `[old](t3-thread://v1/t1)`.",
        "```md",
        "<t3-thread://v2/local/t1>",
        "```",
        "After [New](t3-thread://v2/local/t1)",
      ].join("\n"),
    );
  });

  it("lists the threads a message's links can name, outside code", () => {
    expect(
      threadLinkRefs(
        "<t3-thread://v2/there/t1> [a](t3-thread://v1/t%3A2) `<t3-thread://v2/code/t3>`",
        local,
      ),
    ).toEqual([ref("there", "t1"), ref("local", "t%3A2"), ref("local", "t:2")]);
  });

  it("writes a titleless autolink that opens that exact thread", () => {
    const link = formatThreadLink(ref("env-1", "thread:delegated-task:mcp%3A1"));
    expect(link).toBe("<t3-thread://v2/env-1/thread:delegated-task:mcp%3A1>");
    expect(parseThreadLinkHref(link.slice(1, -1))).toEqual(
      ref("env-1", "thread:delegated-task:mcp%3A1"),
    );
  });

  it("formats a label that would otherwise break the Markdown link", () => {
    expect(formatThreadLink(ref("e", "t1"), "Fix [ci] \\ build")).toBe(
      "[Fix ci build](t3-thread://v2/e/t1)",
    );
    expect(formatThreadLink(ref("e", "t1"), " ] ")).toBe("<t3-thread://v2/e/t1>");
  });
});
