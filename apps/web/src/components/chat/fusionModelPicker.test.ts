import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { collapseFusionModels, findFusionLeadPairing } from "./fusionModelPicker";

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
    const result = collapseFusionModels(entries, instanceId, "opus-glm");
    expect(result.map((model) => [model.instanceId, model.slug, model.name])).toEqual([
      [instanceId, "swe", "SWE-2"],
      [instanceId, "opus-glm", "Fusion"],
      [otherInstanceId, "fable-swe", "Fusion"],
    ]);
  });

  it("keeps a removed saved pairing visible alongside the available Fusion entry", () => {
    const unavailable = { ...models[1]!, slug: "old-fusion", isUnavailable: true };
    expect(
      collapseFusionModels([...models, unavailable], instanceId, "old-fusion").map(
        (model) => model.slug,
      ),
    ).toEqual(["swe", "fable-swe", "old-fusion"]);
  });

  it("opens a matching pairing when a search excludes the selected one", () => {
    const matches = models.filter((model) => model.fusion?.lead.id === "fable");
    expect(collapseFusionModels(matches, instanceId, "opus-glm")[0]?.slug).toBe("fable-swe");
  });

  it("keeps the sidekick across leads and falls back only to an offered pairing", () => {
    expect(findFusionLeadPairing(models, "opus", "swe")?.slug).toBe("opus-swe");
    expect(findFusionLeadPairing(models, "fable", "glm")?.slug).toBe("fable-swe");
    expect(findFusionLeadPairing(models, "missing", "swe")).toBeUndefined();
    expect(
      findFusionLeadPairing(
        models.map((model) => ({ ...model, isUnavailable: true })),
        "opus",
        "swe",
      ),
    ).toBeUndefined();
  });
});
