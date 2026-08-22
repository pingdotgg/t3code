import type { ProviderOptionDescriptor } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadSettingsOptionItems, selectableChoices } from "./thread-settings-options";

const effortDescriptor: Extract<ProviderOptionDescriptor, { type: "select" }> = {
  id: "effort",
  label: "Reasoning",
  type: "select",
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium", isDefault: true },
    { id: "high", label: "High" },
    { id: "ultrathink", label: "Ultrathink" },
    { id: "ultracode", label: "Ultracode" },
  ],
  currentValue: "high",
  promptInjectedValues: ["ultrathink"],
};

describe("selectableChoices", () => {
  it("hides prompt-injected and workflow-trigger choices, keeping declared order", () => {
    expect(selectableChoices(effortDescriptor).map((choice) => choice.id)).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });
});

describe("buildThreadSettingsOptionItems", () => {
  const descriptor = (id: string): ProviderOptionDescriptor => ({
    id,
    label: id,
    type: "boolean",
    currentValue: false,
  });

  const itemIds = (items: ReturnType<typeof buildThreadSettingsOptionItems>) =>
    items.map((item) =>
      item.kind === "interaction-mode" ? "interactionMode" : item.descriptor.id,
    );

  it("puts interaction mode immediately after Fast Mode", () => {
    expect(
      itemIds(
        buildThreadSettingsOptionItems(
          [descriptor("effort"), descriptor("fastMode"), descriptor("serviceTier")],
          true,
        ),
      ),
    ).toEqual(["effort", "fastMode", "interactionMode", "serviceTier"]);
  });

  it("still shows interaction mode when the provider has no Fast Mode option", () => {
    expect(
      itemIds(
        buildThreadSettingsOptionItems([descriptor("effort"), descriptor("serviceTier")], true),
      ),
    ).toEqual(["effort", "serviceTier", "interactionMode"]);
  });

  it("does not add interaction mode to existing-thread settings", () => {
    expect(itemIds(buildThreadSettingsOptionItems([descriptor("fastMode")], false))).toEqual([
      "fastMode",
    ]);
  });
});
