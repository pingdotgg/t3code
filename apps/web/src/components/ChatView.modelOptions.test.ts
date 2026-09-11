import type {
  ModelCapabilities,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { preserveCompatibleOptions } from "./ChatView.modelOptions";

function selectDescriptor(
  id: string,
  options: Array<{ id: string; label: string; isDefault?: boolean }>,
): ProviderOptionDescriptor {
  return {
    type: "select",
    id,
    label: id,
    options: options.map((option) => ({
      id: option.id,
      label: option.label,
      ...(option.isDefault ? { isDefault: true } : {}),
    })),
  };
}

function caps(descriptors: ProviderOptionDescriptor[]): ModelCapabilities {
  return { optionDescriptors: descriptors };
}

const effortDescriptor = selectDescriptor("effort", [
  { id: "low", label: "Low", isDefault: true },
  { id: "high", label: "High" },
]);

const variantDescriptor = selectDescriptor("variant", [
  { id: "fast", label: "Fast", isDefault: true },
  { id: "thorough", label: "Thorough" },
]);

describe("preserveCompatibleOptions", () => {
  it("keeps options whose descriptor id exists on the next model", () => {
    const current: ProviderOptionSelection[] = [
      { id: "effort", value: "high" },
      { id: "agent", value: "plan" },
    ];
    const nextCaps = caps([effortDescriptor]);

    const result = preserveCompatibleOptions(current, nextCaps);

    expect(result).toEqual([{ id: "effort", value: "high" }]);
  });

  it("preserves the user's explicit value, not the new model's default", () => {
    const current: ProviderOptionSelection[] = [{ id: "effort", value: "high" }];
    const nextCaps = caps([effortDescriptor]);

    const result = preserveCompatibleOptions(current, nextCaps);

    expect(result).toEqual([{ id: "effort", value: "high" }]);
  });

  it("drops options the new model does not expose", () => {
    const current: ProviderOptionSelection[] = [
      { id: "effort", value: "high" },
      { id: "agent", value: "plan" },
    ];
    const nextCaps = caps([effortDescriptor, variantDescriptor]);

    const result = preserveCompatibleOptions(current, nextCaps);

    expect(result).toEqual([{ id: "effort", value: "high" }]);
  });

  it("returns undefined when no options survive", () => {
    const current: ProviderOptionSelection[] = [{ id: "agent", value: "plan" }];
    const nextCaps = caps([effortDescriptor]);

    expect(preserveCompatibleOptions(current, nextCaps)).toBeUndefined();
  });

  it("returns undefined when the next model has no option descriptors", () => {
    const current: ProviderOptionSelection[] = [{ id: "effort", value: "high" }];
    const nextCaps = caps([]);

    expect(preserveCompatibleOptions(current, nextCaps)).toBeUndefined();
  });

  it("returns undefined when there are no current options", () => {
    expect(preserveCompatibleOptions([], caps([effortDescriptor]))).toBeUndefined();
    expect(preserveCompatibleOptions(null, caps([effortDescriptor]))).toBeUndefined();
    expect(preserveCompatibleOptions(undefined, caps([effortDescriptor]))).toBeUndefined();
  });

  it("returns undefined when capabilities are null", () => {
    const current: ProviderOptionSelection[] = [{ id: "effort", value: "high" }];

    expect(preserveCompatibleOptions(current, null)).toBeUndefined();
    expect(preserveCompatibleOptions(current, undefined)).toBeUndefined();
  });

  it("carries over multiple compatible options", () => {
    const current: ProviderOptionSelection[] = [
      { id: "effort", value: "high" },
      { id: "variant", value: "thorough" },
      { id: "agent", value: "plan" },
    ];
    const nextCaps = caps([effortDescriptor, variantDescriptor]);

    const result = preserveCompatibleOptions(current, nextCaps);

    expect(result).toEqual([
      { id: "effort", value: "high" },
      { id: "variant", value: "thorough" },
    ]);
  });
});
