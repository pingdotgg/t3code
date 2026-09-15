import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { collapseFusionModels, getFusionChoices } from "./fusionModels.ts";

const instanceId = ProviderInstanceId.make("devin-work");
const otherInstanceId = ProviderInstanceId.make("devin-personal");
const fable = { id: "fable", name: "Claude Fable 5.1" };
const opus = { id: "opus", name: "Claude Opus 5" };
const swe = { id: "swe", name: "SWE-2 Medium" };
const glm = { id: "glm", name: "GLM-5.2 High" };
const models = [
  { instanceId, slug: "swe", name: "SWE-2" },
  {
    instanceId,
    slug: "fable-swe",
    name: "Fusion (Fable + SWE)",
    fusion: { lead: fable, sidekick: swe },
  },
  {
    instanceId,
    slug: "opus-swe",
    name: "Fusion (Opus + SWE)",
    fusion: { lead: opus, sidekick: swe },
  },
  {
    instanceId,
    slug: "opus-glm",
    name: "Fusion (Opus + GLM)",
    fusion: { lead: opus, sidekick: glm },
  },
];

describe("Fusion picker", () => {
  it("shows one Fusion entry per account and preserves the selected pairing", () => {
    const entries = [...models, { ...models[1]!, instanceId: otherInstanceId }];
    const result = collapseFusionModels(
      entries,
      (model) => model.instanceId,
      (model) => model.instanceId === instanceId && model.slug === "opus-glm",
    );
    expect(result.map((model) => [model.instanceId, model.slug, model.name])).toEqual([
      [instanceId, "swe", "SWE-2"],
      [instanceId, "opus-glm", "Fusion (Opus + GLM)"],
      [otherInstanceId, "fable-swe", "Fusion (Fable + SWE)"],
    ]);
  });

  it("keeps a removed saved pairing visible alongside the available Fusion entry", () => {
    const unavailable = { ...models[1]!, slug: "old-fusion", isUnavailable: true };
    expect(
      collapseFusionModels(
        [...models, unavailable],
        (model) => model.instanceId,
        (model) => model.slug === "old-fusion",
      ).map((model) => model.slug),
    ).toEqual(["swe", "fable-swe", "old-fusion"]);
  });

  it("opens a matching pairing when a search excludes the selected one", () => {
    const matches = models.filter((model) => model.fusion?.lead.id === "fable");
    expect(
      collapseFusionModels(
        matches,
        (model) => model.instanceId,
        (model) => model.slug === "opus-glm",
      )[0]?.slug,
    ).toBe("fable-swe");
  });

  it("offers one pairing per lead, preserving the sidekick when possible", () => {
    const choices = getFusionChoices(models, models[3]!);
    expect(choices.lead.map((model) => model.slug)).toEqual(["fable-swe", "opus-glm"]);
    expect(choices.sidekick.map((model) => model.slug)).toEqual(["opus-swe", "opus-glm"]);
    expect(getFusionChoices(models, models[1]!).lead.map((model) => model.slug)).toEqual([
      "fable-swe",
      "opus-swe",
    ]);
  });

  it("falls back to an offered pairing when the matching sidekick becomes unavailable", () => {
    const available = models.map((model) => ({
      ...model,
      isUnavailable: model.slug === "opus-glm",
    }));
    expect(getFusionChoices(available, models[3]!).lead.map((model) => model.slug)).toEqual([
      "fable-swe",
      "opus-swe",
    ]);
    expect(getFusionChoices(available, models[3]!).sidekick.map((model) => model.slug)).toEqual([
      "opus-swe",
    ]);
    expect(
      getFusionChoices(
        models.map((model) => ({ ...model, isUnavailable: true })),
        models[3]!,
      ),
    ).toEqual({ lead: [], sidekick: [] });
  });
});
