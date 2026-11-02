import { describe, expect, it } from "vite-plus/test";

import { resolvePlanThreadModeControl } from "./legacy-plan-mode";

describe("resolvePlanThreadModeControl", () => {
  const toggle = { showInteractionModeToggle: true };
  const hidden = { showInteractionModeToggle: false };
  it.each([
    {
      name: "persisted plan thread",
      isDraft: false,
      persisted: "plan",
      draft: undefined,
      provider: toggle,
      expected: "plan",
    },
    {
      name: "persisted plan thread switched to Build",
      isDraft: false,
      persisted: "plan",
      draft: "default",
      provider: toggle,
      expected: "default",
    },
    {
      name: "default thread with a stale plan draft",
      isDraft: false,
      persisted: "default",
      draft: "plan",
      provider: toggle,
      expected: null,
    },
    {
      name: "new task draft in plan",
      isDraft: true,
      persisted: "plan",
      draft: "plan",
      provider: toggle,
      expected: null,
    },
    {
      name: "provider hides the toggle",
      isDraft: false,
      persisted: "plan",
      draft: undefined,
      provider: hidden,
      expected: null,
    },
    {
      name: "provider unknown",
      isDraft: false,
      persisted: "plan",
      draft: undefined,
      provider: null,
      expected: null,
    },
  ] as const)("$name", ({ isDraft, persisted, draft, provider, expected }) => {
    expect(
      resolvePlanThreadModeControl({
        isDraft,
        persistedInteractionMode: persisted,
        draftInteractionMode: draft,
        provider,
      }),
    ).toBe(expected);
  });
});
