import { parseNewThreadLink } from "@t3tools/shared/promptLinks";
import { describe, expect, it } from "vite-plus/test";

import {
  promptLinkSearchFromParams,
  stepPendingPromptLink,
  withoutPromptLinkParams,
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
});

describe("stepPendingPromptLink", () => {
  const waiting = "repo=t3tools%2Ft3code";

  it("drops a link whose screen is missing from the first state after it was parsed", () => {
    expect(stepPendingPromptLink(waiting, { screenOnStack: false, ready: true })).toEqual({
      pending: null,
      resolve: null,
    });
  });

  it("holds a link on its screen until its target is ready, then resolves it once", () => {
    expect(stepPendingPromptLink(waiting, { screenOnStack: true, ready: false })).toEqual({
      pending: waiting,
      resolve: null,
    });
    expect(stepPendingPromptLink(waiting, { screenOnStack: true, ready: true })).toEqual({
      pending: null,
      resolve: waiting,
    });
  });

  it("drops a link whose screen was left before its target was ready", () => {
    expect(stepPendingPromptLink(waiting, { screenOnStack: false, ready: false })).toEqual({
      pending: null,
      resolve: null,
    });
  });
});

describe("withoutPromptLinkParams", () => {
  it("keeps the route's other params", () => {
    expect(withoutPromptLinkParams({ prompt: "hi", repo: "a/b", incomingShareId: "1" })).toEqual({
      incomingShareId: "1",
    });
  });
});
