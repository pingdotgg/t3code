import { parseNewThreadLink } from "@t3tools/shared/promptLinks";
import { describe, expect, it } from "vite-plus/test";

import {
  latestThreadEnvironmentIds,
  linkedThreadDraftAction,
  promptLinkNotice,
  promptLinkScratchEnvironmentId,
  promptLinkSearchFromParams,
} from "./prompt-link-model";

describe("promptLinkSearchFromParams", () => {
  it("round-trips decoded route params into the shared parser", () => {
    const search = promptLinkSearchFromParams({
      prompt: "Fix the bug & add tests = done?",
      repo: ["pingdotgg/t3code", "ignored/second"],
      provider: "codex",
      screen: "NewTask",
    });

    expect(parseNewThreadLink(search ?? "")).toEqual({
      ok: true,
      value: {
        kind: "new",
        prompt: { text: "Fix the bug & add tests = done?", hiddenCharacters: 0 },
        repository: { owner: "pingdotgg", name: "t3code" },
        provider: "codex",
        model: null,
      },
    });
  });

  it("is null for routes without a prompt link", () => {
    expect(promptLinkSearchFromParams({ incomingShareId: "share-1" })).toBeNull();
    expect(promptLinkSearchFromParams(undefined)).toBeNull();
  });
});

describe("promptLinkNotice", () => {
  it("replaces the plain notice with the hidden character warning", () => {
    expect(promptLinkNotice({ hiddenCharacters: 0 })).toBe(
      "This prompt came from a link. Read it before you send.",
    );
    expect(promptLinkNotice({ hiddenCharacters: 2, modelUnavailable: true })).toBe(
      "This prompt had hidden characters, it may be malicious. They were removed. Read it before you send.\n\nThe requested model is not available, so your default is used.",
    );
  });
});

describe("linkedThreadDraftAction", () => {
  it("fills an empty composer and asks before replacing typed text", () => {
    expect(linkedThreadDraftAction("  \n", "Do it")).toBe("fill");
    expect(linkedThreadDraftAction("Do it", "Do it")).toBe("keep");
    expect(linkedThreadDraftAction("My notes", "Do it")).toBe("ask");
  });
});

describe("promptLinkScratchEnvironmentId", () => {
  it("prefers the most recently active machine that offers threads without a project", () => {
    expect(promptLinkScratchEnvironmentId(["a", "b", "c"], ["c", "b"])).toBe("b");
    expect(promptLinkScratchEnvironmentId(["a"], ["c"])).toBe("c");
    expect(promptLinkScratchEnvironmentId(["a"], [])).toBeNull();
  });
});

describe("latestThreadEnvironmentIds", () => {
  it("orders machines by their latest thread", () => {
    expect(
      latestThreadEnvironmentIds([
        { environmentId: "a", updatedAt: "2026-01-02T00:00:00.000Z" },
        { environmentId: "b", updatedAt: "2026-01-03T00:00:00.000Z" },
        { environmentId: "a", updatedAt: "2026-01-04T00:00:00.000Z" },
      ]),
    ).toEqual(["a", "b"]);
  });
});
