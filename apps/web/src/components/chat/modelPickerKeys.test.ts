import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  modelPickerLegacySectionKey,
  modelPickerModelKey,
  modelPickerProviderGroupKey,
  parseModelPickerLegacySectionKey,
  parseModelPickerModelKey,
  parseModelPickerProviderGroupKey,
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

describe("provider group keys", () => {
  it("round-trips a driver kind", () => {
    const key = modelPickerProviderGroupKey(ProviderDriverKind.make("claudeAgent"));
    expect(parseModelPickerProviderGroupKey(key)).toBe("claudeAgent");
  });

  it("is distinct from model and legacy section keys", () => {
    const groupKey = modelPickerProviderGroupKey(ProviderDriverKind.make("codex"));
    const modelKey = modelPickerModelKey(ProviderInstanceId.make("codex"), "gpt-5");
    const legacyKey = modelPickerLegacySectionKey(ProviderInstanceId.make("codex"));

    expect(groupKey).not.toBe(modelKey);
    expect(groupKey).not.toBe(legacyKey);
    expect(parseModelPickerModelKey(groupKey)).toBeNull();
    expect(parseModelPickerLegacySectionKey(groupKey)).toBeNull();
  });

  it("returns null for non-group keys", () => {
    expect(parseModelPickerProviderGroupKey("model:5:codexgpt-5")).toBeNull();
    expect(parseModelPickerProviderGroupKey("legacy-models:codex")).toBeNull();
  });
});
