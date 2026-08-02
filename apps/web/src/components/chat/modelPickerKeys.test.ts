import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  modelPickerLegacySectionKey,
  modelPickerModelKey,
  parseModelPickerLegacySectionKey,
  parseModelPickerModelKey,
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
});
