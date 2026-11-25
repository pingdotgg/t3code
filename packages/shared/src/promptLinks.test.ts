import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildNewThreadLink,
  parseNewThreadLink,
  parseThreadLinkPrompt,
  promptLinkAppPath,
  promptLinkDeepLink,
  sanitizeLinkedPrompt,
  withoutPromptLinkParams,
} from "./promptLinks.ts";
import { shareableThreadLink } from "./threadLinks.ts";

describe("sanitizeLinkedPrompt", () => {
  it("removes characters a reader cannot see and counts them", () => {
    const tagged = "rate me" + String.fromCodePoint(0xe0041, 0xe0042);
    expect(sanitizeLinkedPrompt(`a\u200Bb\u202Ec\uFEFF${tagged}`)).toEqual({
      text: "abcrate me",
      hiddenCharacters: 5,
    });
    expect(sanitizeLinkedPrompt("a\u2028b\u2029c")).toEqual({
      text: "a\nb\nc",
      hiddenCharacters: 0,
    });
  });

  it("keeps emoji sequences intact", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    const heart = "\u2764\uFE0F";
    expect(sanitizeLinkedPrompt(`${family} ${heart}`)).toEqual({
      text: `${family} ${heart}`,
      hiddenCharacters: 0,
    });
    expect(sanitizeLinkedPrompt("a\u200Db").hiddenCharacters).toBe(1);
    expect(sanitizeLinkedPrompt("\u{1F468}\u200D").hiddenCharacters).toBe(1);
    expect(sanitizeLinkedPrompt("\u{20000}\u200D\u{20001}").hiddenCharacters).toBe(1);
  });
});

describe("parseNewThreadLink", () => {
  it("reads a shared prompt with its optional repository and model", () => {
    const result = parseNewThreadLink(
      "?prompt=Rate+me&repo=https://github.com/pingdotgg/t3code.git&provider=Codex&model=gpt-5",
    );
    expect(result).toEqual({
      ok: true,
      value: {
        kind: "new",
        prompt: { text: "Rate me", hiddenCharacters: 0 },
        repository: { owner: "pingdotgg", name: "t3code" },
        provider: "codex",
        model: "gpt-5",
      },
    });
  });

  it("reads a pull request link, whose prompt is optional", () => {
    for (const pr of [
      "pingdotgg/t3code/42",
      "pingdotgg/t3code%2342",
      "https://github.com/pingdotgg/t3code/pull/42/files",
    ]) {
      expect(parseNewThreadLink(`?pr=${pr}`)).toEqual({
        ok: true,
        value: {
          kind: "pull-request",
          pullRequest: { owner: "pingdotgg", name: "t3code", number: 42 },
          prompt: null,
        },
      });
    }
  });

  it("refuses links it cannot open safely", () => {
    expect(parseNewThreadLink("?repo=a/b").ok).toBe(false);
    expect(parseNewThreadLink("?prompt=%E2%80%8B").ok).toBe(false);
    expect(parseThreadLinkPrompt("?prompt=%E2%80%8B").ok).toBe(false);
    expect(parseNewThreadLink("?prompt=x&repo=../etc").ok).toBe(false);
    expect(parseNewThreadLink(`?prompt=${"x".repeat(8_001)}`).ok).toBe(false);
  });
});

describe("thread links", () => {
  it("reads the prompt and leaves other parameters in place", () => {
    expect(parseThreadLinkPrompt("?prompt=Fix+it")).toEqual({
      ok: true,
      value: { text: "Fix it", hiddenCharacters: 0 },
    });
    expect(parseThreadLinkPrompt("?panel=diff")).toEqual({ ok: true, value: null });
    expect(withoutPromptLinkParams("?prompt=x&panel=diff")).toBe("?panel=diff");
  });
});

describe("link round trips", () => {
  it("builds a link on the server's web app that parses back to the same prompt", () => {
    const origin = "http://192.168.1.5:3773";
    const link = buildNewThreadLink({
      prompt: "Swear count & rating?",
      repository: { owner: "pingdotgg", name: "t3code" },
      provider: "claudeAgent",
      model: "opus",
      origin,
    });
    expect(new URL(link).origin).toBe(origin);
    const path = promptLinkAppPath(link, origin);
    expect(path).toBe(new URL(link).pathname + new URL(link).search);
    expect(promptLinkAppPath(link)).toBeNull();
    const parsed = parseNewThreadLink(new URL(link).search);
    expect(parsed.ok && parsed.value.kind === "new" && parsed.value.prompt.text).toBe(
      "Swear count & rating?",
    );
  });

  it("opens a prompt link without a server in the app", () => {
    const link = buildNewThreadLink({ prompt: "hi" });
    expect(link).toBe("t3code://new?prompt=hi");
    expect(promptLinkAppPath(link)).toBe("/new?prompt=hi");
  });

  it("opens a copied thread link in the app at that thread", () => {
    const thread = { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("mcp:1") };
    const origin = "http://192.168.1.5:3773";
    const path = promptLinkAppPath(shareableThreadLink(thread, origin), origin);
    expect(path).toBe("/env-1/mcp%3A1");
    expect(promptLinkAppPath(shareableThreadLink(thread, null))).toBe(path);
    const deepLink = promptLinkDeepLink(path!);
    expect(deepLink).toBe("t3code://threads/env-1/mcp%3A1");
    expect(promptLinkAppPath(deepLink)).toBe(path);
  });

  it("maps app scheme and the given web app's links to in-app paths, and nothing else", () => {
    const origin = "https://box.tail1.ts.net";
    expect(promptLinkAppPath("t3code://new?prompt=hi")).toBe("/new?prompt=hi");
    expect(promptLinkAppPath("t3code-dev://threads/env-1/thread-1")).toBe("/env-1/thread-1");
    expect(promptLinkAppPath(`${origin}/env-1/thread-1?prompt=go`, origin)).toBe(
      "/env-1/thread-1?prompt=go",
    );
    expect(promptLinkAppPath(`${origin}/threads/env-1/thread-1`, origin)).toBe("/env-1/thread-1");
    expect(promptLinkAppPath(`${origin}/threads/env-1/thread-1?prompt=go`, origin)).toBe(
      "/env-1/thread-1?prompt=go",
    );
    // The web app's own thread route, reloaded, is no link.
    expect(promptLinkAppPath(`${origin}/env-1/thread-1`, origin)).toBeNull();
    expect(promptLinkAppPath(`${origin}/threads/env-1`, origin)).toBeNull();
    expect(promptLinkAppPath(`${origin}/settings/general`, origin)).toBeNull();
    expect(promptLinkAppPath("https://app.t3.codes/threads/env-1/thread-1")).toBeNull();
    expect(promptLinkAppPath("https://evil.test/new?prompt=hi", origin)).toBeNull();
    expect(promptLinkAppPath("t3code://app/index.html")).toBeNull();
  });

  it("maps links in browsers without URL.canParse, such as Safari before 17", () => {
    const canParse = URL.canParse;
    Reflect.deleteProperty(URL, "canParse");
    try {
      const origin = "https://box.tail1.ts.net";
      expect(promptLinkAppPath(`${origin}/new?prompt=hi`, origin)).toBe("/new?prompt=hi");
      expect(promptLinkAppPath(`${origin}/`, origin)).toBeNull();
      expect(promptLinkAppPath("not a url")).toBeNull();
    } finally {
      URL.canParse = canParse;
    }
  });
});
