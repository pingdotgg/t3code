import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  modelPickerLegacySectionKey,
  modelPickerModelKey,
  modelPickerSubProviderSectionKey,
  parseModelPickerLegacySectionKey,
  parseModelPickerModelKey,
  parseModelPickerSubProviderSectionKey,
} from "./modelPickerKeys";

describe("model picker item keys", () => {
  it("keeps model and legacy section keys distinct for colliding instance names", () => {
    const modelKey = modelPickerModelKey(ProviderInstanceId.make("legacy-models"), "codex");
    const sectionKey = modelPickerLegacySectionKey(ProviderInstanceId.make("codex"));

    expect(modelKey).not.toBe(sectionKey);
    expect(parseModelPickerLegacySectionKey(modelKey)).toBeNull();
    expect(parseModelPickerModelKey(modelKey)).toEqual({
      instanceId: "legacy-models",
      slug: "codex",
    });
  });

  it("round-trips arbitrary strings without throwing", () => {
    const instanceId = ProviderInstanceId.make("custom");
    const slug = "model:\udfff";

    const key = modelPickerModelKey(instanceId, slug);

    expect(parseModelPickerModelKey(key)).toEqual({ instanceId, slug });
  });

  it("round-trips sub-provider section keys and keeps them distinct from model keys", () => {
    const instanceId = ProviderInstanceId.make("opencode");
    const subProvider = "OpenCode Zen";

    const sectionKey = modelPickerSubProviderSectionKey(instanceId, subProvider);

    expect(parseModelPickerSubProviderSectionKey(sectionKey)).toEqual({ instanceId, subProvider });
    expect(parseModelPickerModelKey(sectionKey)).toBeNull();
    expect(parseModelPickerLegacySectionKey(sectionKey)).toBeNull();
    expect(
      parseModelPickerSubProviderSectionKey(modelPickerModelKey(instanceId, subProvider)),
    ).toBeNull();
  });
});
