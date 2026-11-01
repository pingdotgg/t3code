import { describe, expect, it } from "vite-plus/test";

import { rehypePullRequestMentions } from "./pullRequestMentions";

type Node = Parameters<ReturnType<typeof rehypePullRequestMentions>>[0];

function mentions(text: string, viewer: string | null = "Adamulek123") {
  const tree: Node = { type: "root", children: [{ type: "text", value: text }] };
  rehypePullRequestMentions({ repositoryUrl: "https://github.com/pingdotgg/t3code", viewer })(
    tree,
    {},
  );
  return tree.children?.filter((child) => child.tagName === "a") ?? [];
}

describe("pull request mentions", () => {
  it("links other people and highlights only the reader, preserving spelling", () => {
    expect(mentions("Thanks @PixPMusic, @ADAMULEK123 and @juliusmarminge.")).toEqual([
      {
        type: "element",
        tagName: "a",
        properties: { href: "https://github.com/PixPMusic", dataPullRequestMention: "user" },
        children: [{ type: "text", value: "@PixPMusic" }],
      },
      {
        type: "element",
        tagName: "a",
        properties: { href: "https://github.com/ADAMULEK123", dataPullRequestMention: "self" },
        children: [{ type: "text", value: "@ADAMULEK123" }],
      },
      {
        type: "element",
        tagName: "a",
        properties: { href: "https://github.com/juliusmarminge", dataPullRequestMention: "user" },
        children: [{ type: "text", value: "@juliusmarminge" }],
      },
    ]);
  });

  it.each([
    "me@Adamulek123.com",
    "@@Adamulek123",
    "@Adamulek123/team",
    "@Adamulek123-",
    "@some--name",
    "@foo_bar",
    "path/@Adamulek123",
    "é@Adamulek123",
    `@${"a".repeat(40)}`,
  ])("leaves non-mentions intact: %s", (text) => {
    expect(mentions(text)).toEqual([]);
  });

  it("does not highlight a longer login matching the viewer prefix", () => {
    expect(mentions("@Adamulek1234")[0]?.properties).toEqual({
      href: "https://github.com/Adamulek1234",
      dataPullRequestMention: "user",
    });
  });

  it("links valid short and hyphenated names next to punctuation", () => {
    expect(mentions("(@a), **@some-name**!").map((node) => node.properties?.href)).toEqual([
      "https://github.com/a",
      "https://github.com/some-name",
    ]);
  });

  it("still links people when an older server supplies no viewer", () => {
    expect(mentions("@Adamulek123", null)[0]?.properties?.dataPullRequestMention).toBe("user");
  });

  it("uses the repository host for Enterprise profiles", () => {
    const tree: Node = { type: "root", children: [{ type: "text", value: "@adam" }] };
    rehypePullRequestMentions({
      repositoryUrl: "https://git.example.com:8443/team/repo",
      viewer: "adam",
    })(tree, {});
    expect(tree.children?.[0]?.properties?.href).toBe("https://git.example.com:8443/adam");
  });

  it.each(["a", "code", "pre", "kbd", "samp"])("leaves %s contents untouched", (tagName) => {
    const tree: Node = {
      type: "element",
      tagName,
      children: [{ type: "text", value: "@Adamulek123" }],
    };
    const original = structuredClone(tree);
    rehypePullRequestMentions({ repositoryUrl: "https://github.com/team/repo" })(tree, {});
    expect(tree).toEqual(original);
  });

  it("retains all surrounding text and nested formatting", () => {
    const tree: Node = {
      type: "element",
      tagName: "strong",
      children: [{ type: "text", value: "Hello @a, then @b!" }],
    };
    rehypePullRequestMentions({ repositoryUrl: "https://github.com/team/repo" })(tree, {});
    expect(tree.tagName).toBe("strong");
    expect(tree.children?.map((node) => node.value ?? node.children?.[0]?.value).join("")).toBe(
      "Hello @a, then @b!",
    );
  });
});
