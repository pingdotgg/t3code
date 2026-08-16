import { describe, expect, it } from "vite-plus/test";

import { decodePiModelSlug, encodePiModelSlug, mapPiDiscoveredModels } from "./PiModel.ts";

describe("PiModel", () => {
  it("round-trips provider and model ids with one raw delimiter", () => {
    const slug = encodePiModelSlug("open/router", "model / β");
    expect(slug).toBe("open%2Frouter/model%20%2F%20%CE%B2");
    expect(decodePiModelSlug(slug!)).toEqual({ provider: "open/router", modelId: "model / β" });
  });

  it.each(["provider", "/model", "provider/", "provider/model/extra", "a/%", "a/%2f", " a/model"])(
    "rejects invalid or noncanonical slug %s",
    (slug) => expect(decodePiModelSlug(slug)).toBeUndefined(),
  );

  it("maps Pi's configured model and thinking defaults", () => {
    expect(
      mapPiDiscoveredModels(
        [
          {
            provider: "anthropic",
            id: "claude/opus",
            name: "Claude Opus",
            thinkingLevels: ["low", "high", "max"],
          },
          { provider: " ", id: "bad", name: "Bad" },
        ],
        {
          provider: "anthropic",
          modelId: "claude/opus",
          thinkingLevel: "high",
        },
      ),
    ).toEqual([
      {
        slug: "anthropic/claude%2Fopus",
        name: "Claude Opus",
        subProvider: "anthropic",
        isCustom: false,
        isDefault: true,
        capabilities: {
          optionDescriptors: [
            {
              id: "thinkingLevel",
              label: "Thinking level",
              type: "select",
              options: [
                { id: "low", label: "low" },
                { id: "high", label: "high" },
                { id: "max", label: "max" },
              ],
              currentValue: "high",
            },
          ],
        },
      },
    ]);
  });
});
