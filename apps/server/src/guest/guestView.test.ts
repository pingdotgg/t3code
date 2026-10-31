import { describe, expect, it } from "@effect/vitest";

import { guestThreadModel } from "./guestView.ts";

describe("guestThreadModel", () => {
  const providers = [
    {
      instanceId: "claude-work",
      driver: "claudeAgent",
      models: [
        {
          slug: "claude-opus",
          name: "Claude Opus",
          shortName: "Opus",
          isCustom: false,
          capabilities: null,
        },
      ],
    },
  ] as unknown as Parameters<typeof guestThreadModel>[1];

  it("names the model as the owner's picker does, or by its id when it is not listed", () => {
    const selection = (instanceId: string, model: string) =>
      ({ instanceId, model }) as Parameters<typeof guestThreadModel>[0];
    expect(guestThreadModel(selection("claude-work", "claude-opus"), providers)).toEqual({
      driver: "claudeAgent",
      name: "Claude Opus",
      shortName: "Opus",
    });
    expect(guestThreadModel(selection("removed", "gpt-5"), providers)).toEqual({
      driver: null,
      name: "gpt-5",
    });
  });
});
