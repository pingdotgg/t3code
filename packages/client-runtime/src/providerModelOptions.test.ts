import type {
  ModelCapabilities,
  ProviderOptionSelection,
  ServerProvider,
} from "@t3tools/contracts";
import { buildProviderOptionSelectionsFromDescriptors } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";
import {
  resolveProviderModelOptions,
  withImplicitFastModeDefault,
} from "./providerModelOptions.ts";

const capabilities: ModelCapabilities = {
  optionDescriptors: [
    {
      id: "reasoning",
      label: "Reasoning",
      type: "select",
      options: [{ id: "high", label: "High", isDefault: true }],
    },
    { id: "fastMode", label: "Fast", type: "boolean", currentValue: true },
  ],
};
const saved = [{ id: "reasoning", value: "removed" }];

describe("provider model options", () => {
  it.each<ServerProvider["modelPolicy"]>([
    undefined,
    { catalogScope: "instance", preserveUnavailableModels: true },
  ])("normalizes ordinary options independently of catalog scope (%j)", (policy) => {
    expect(resolveProviderModelOptions(capabilities, saved, policy).selections).toEqual([
      { id: "reasoning", value: "high" },
    ]);
  });

  it.each([capabilities, {}, null])("keeps exact options visible and unchanged (%j)", (caps) => {
    const { descriptors, selections } = resolveProviderModelOptions(caps, saved, {
      optionSelection: "exact",
    });
    expect(selections).toBe(saved);
    expect(descriptors.find((descriptor) => descriptor.id === "reasoning")).toMatchObject({
      currentValue: "removed",
      options: expect.arrayContaining([{ id: "removed", label: "removed (Unavailable)" }]),
    });
  });

  it.each([
    { caps: capabilities, saved: [{ id: "reasoning", value: true }] },
    { caps: capabilities, saved: [{ id: "fastMode", value: "removed" }] },
  ])("keeps saved options editable when the descriptor changes type (%j)", ({ caps, saved }) => {
    const { descriptors } = resolveProviderModelOptions(caps, saved, { optionSelection: "exact" });
    expect(buildProviderOptionSelectionsFromDescriptors(descriptors)).toEqual(
      expect.arrayContaining<ProviderOptionSelection>(saved),
    );
  });

  it("never injects native variant defaults", () => {
    const policy = { optionSelection: "exact" } as const;
    expect(withImplicitFastModeDefault(capabilities, undefined, policy)).toBeUndefined();
    expect(resolveProviderModelOptions(capabilities, undefined, policy).selections).toBeUndefined();
    expect(withImplicitFastModeDefault(capabilities, undefined)).toEqual([
      { id: "fastMode", value: false },
    ]);
  });
});
