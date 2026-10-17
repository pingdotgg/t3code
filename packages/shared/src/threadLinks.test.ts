import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  formatThreadLink,
  parseThreadLinkHref,
  relabelThreadLinks,
  resolveThreadLinkRef,
} from "./threadLinks.ts";

const ref = (environmentId: string, threadId = "chat-1") => ({
  environmentId: EnvironmentId.make(environmentId),
  threadId: ThreadId.make(threadId),
});

describe("thread link destinations", () => {
  it.each([
    ["environment-a", "environment-b"],
    ["environment-b", "environment-a"],
  ])("finds a chat on %s from a message on %s", (target, source) => {
    const destination = ref(target);
    expect(resolveThreadLinkRef(ref(source), [ref(source, "other-chat"), destination])).toBe(
      destination,
    );
  });

  it("keeps the message's environment when the id exists in both", () => {
    const local = ref("environment-a");
    expect(resolveThreadLinkRef(local, [ref("environment-b"), local])).toBe(local);
  });

  it("does not choose between ambiguous remote destinations", () => {
    expect(
      resolveThreadLinkRef(ref("environment-a"), [ref("environment-b"), ref("environment-c")]),
    ).toBeNull();
  });

  it("preserves percent escapes that belong to a remote thread id", () => {
    const destination = ref("environment-b", "provider%3A1");
    expect(
      resolveThreadLinkRef(ref("environment-a", "provider%3A1"), [
        ref("environment-b", "provider:1"),
        destination,
      ]),
    ).toBe(destination);
  });

  it("finds a remote thread when the agent encoded its id", () => {
    const destination = ref("environment-b", "provider:1");
    expect(resolveThreadLinkRef(ref("environment-a", "provider%3A1"), [destination])).toBe(
      destination,
    );
  });

  it("keeps a decoded local match ahead of a remote match", () => {
    const local = ref("environment-a", "provider:1");
    expect(
      resolveThreadLinkRef(ref("environment-a", "provider%3A1"), [
        ref("environment-b", "provider%3A1"),
        local,
      ]),
    ).toBe(local);
  });

  it("leaves an unavailable chat unresolved", () => {
    expect(
      resolveThreadLinkRef(ref("environment-a"), [ref("environment-b", "other-chat")]),
    ).toBeNull();
  });
});

describe("thread links", () => {
  it("takes the thread id verbatim, percent escapes included", () => {
    expect(parseThreadLinkHref("t3-thread://v1/mcp:1234")).toBe("mcp:1234");
    expect(parseThreadLinkHref("t3-thread://v1/thread:delegated-task:mcp%3A1")).toBe(
      "thread:delegated-task:mcp%3A1",
    );
  });

  it("rejects other links and an empty id", () => {
    expect(parseThreadLinkHref("https://t3.codes")).toBeNull();
    expect(parseThreadLinkHref("t3-thread://v1/")).toBeNull();
    expect(parseThreadLinkHref("t3-thread://v1/ ")).toBeNull();
  });

  it("resolves a percent-encoded id when the id as written names no thread", () => {
    const titles = new Map([
      ["thread:project:1", "Decoded"],
      ["provider%3A1", "Literal escape"],
    ]);
    expect(
      relabelThreadLinks(
        "[a](t3-thread://v1/thread%3Aproject%3A1) [b](t3-thread://v1/provider%3A1)",
        (threadId) => titles.get(threadId),
      ),
    ).toBe(
      "[Decoded](t3-thread://v1/thread:project:1) [Literal escape](t3-thread://v1/provider%3A1)",
    );
    const untitled = new Map([
      ["a%3A1", ""],
      ["a:1", "Other"],
    ]);
    expect(
      relabelThreadLinks("[Kept](t3-thread://v1/a%3A1)", (threadId) => untitled.get(threadId)),
    ).toBe("[Kept](t3-thread://v1/a%3A1)");
  });

  it("leaves links inside code spans and fences as written", () => {
    const markdown = [
      "Live [old](t3-thread://v1/t1), literal `[old](t3-thread://v1/t1)`.",
      "```md",
      "[old](t3-thread://v1/t1)",
      "```",
      "After [old](t3-thread://v1/t1)",
    ].join("\n");
    expect(relabelThreadLinks(markdown, () => "New")).toBe(
      [
        "Live [New](t3-thread://v1/t1), literal `[old](t3-thread://v1/t1)`.",
        "```md",
        "[old](t3-thread://v1/t1)",
        "```",
        "After [New](t3-thread://v1/t1)",
      ].join("\n"),
    );
  });

  it("formats a label that would otherwise break the Markdown link", () => {
    expect(formatThreadLink("t1", "Fix [ci] \\ build")).toBe("[Fix ci build](t3-thread://v1/t1)");
    expect(formatThreadLink("t1", " ] ")).toBe("[t1](t3-thread://v1/t1)");
  });

  it("relabels links with the current title and leaves unknown threads alone", () => {
    const titles = new Map([["renamed", "Fix [the] build\nnow"]]);
    expect(
      relabelThreadLinks(
        "See [Old name](t3-thread://v1/renamed) and [Gone](t3-thread://v1/deleted).",
        (threadId) => titles.get(threadId),
      ),
    ).toBe("See [Fix the build now](t3-thread://v1/renamed) and [Gone](t3-thread://v1/deleted).");
  });
});
