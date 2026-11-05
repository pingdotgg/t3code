import { describe, expect, it } from "vite-plus/test";

import type { ModelCapabilities, ProviderOptionSelection } from "@t3tools/contracts";

import { applyProviderOptionSelection, resolveProviderOptionDescriptors } from "./providerOptions";

const CODEX_CAPABILITIES: ModelCapabilities = {
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
      ],
      currentValue: "medium",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        { id: "priority", label: "Fast" },
      ],
      currentValue: "default",
    },
  ],
};

describe("mobile provider options", () => {
  it("updates generic select options without knowing provider-specific ids", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: CODEX_CAPABILITIES,
      selections: undefined,
    });

    expect(
      applyProviderOptionSelection(
        descriptors,
        { id: "serviceTier", value: "priority" },
        undefined,
      ),
    ).toEqual([
      { id: "reasoningEffort", value: "medium" },
      { id: "serviceTier", value: "priority" },
    ]);
    // Choices the model doesn't advertise are rejected, not stored.
    expect(
      applyProviderOptionSelection(descriptors, { id: "serviceTier", value: "turbo" }, undefined),
    ).toBeNull();
    expect(
      applyProviderOptionSelection(descriptors, { id: "unknown", value: "high" }, undefined),
    ).toBeNull();
  });

  it("updates generic boolean options", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: {
        optionDescriptors: [{ id: "fastMode", label: "Fast Mode", type: "boolean" }],
      },
      selections: undefined,
    });

    expect(
      applyProviderOptionSelection(descriptors, { id: "fastMode", value: true }, undefined),
    ).toEqual([{ id: "fastMode", value: true }]);
  });
  // The settings sheet passes the stored options of the selection it edits:
  // the applied thread or composer selection, a staged model's pending one,
  // or a scheduled task's draft selection.
  it("stores a later model only when it was picked", () => {
    const capabilities: ModelCapabilities = {
      optionDescriptors: [
        {
          id: "model",
          label: "Model",
          type: "select",
          selectsModel: true,
          options: [
            { id: "cline-pass/mimo-v2.6-flash", label: "MiMo" },
            { id: "cline-pass/kimi-k3", label: "Kimi" },
          ],
          currentValue: "cline-pass/mimo-v2.6-flash",
        },
        { id: "auto_approve", label: "Auto-approve tools", type: "boolean", currentValue: false },
      ],
    };
    const toggle = (saved: ReadonlyArray<ProviderOptionSelection> | undefined) =>
      applyProviderOptionSelection(
        resolveProviderOptionDescriptors({ capabilities, selections: saved }),
        { id: "auto_approve", value: true },
        saved,
      );

    expect(toggle(undefined)).toEqual([{ id: "auto_approve", value: true }]);
    expect(toggle([{ id: "auto_approve", value: false }])).toEqual([
      { id: "auto_approve", value: true },
    ]);
    // A saved model the catalog dropped is kept for the session to reject.
    const saved = [{ id: "model", value: "cline-pass/muse-spark-1.2-contributor" }];
    expect(toggle(saved)).toEqual([...saved, { id: "auto_approve", value: true }]);
    expect(
      applyProviderOptionSelection(
        resolveProviderOptionDescriptors({ capabilities, selections: undefined }),
        { id: "model", value: "cline-pass/kimi-k3" },
        undefined,
      ),
    ).toEqual([
      { id: "model", value: "cline-pass/kimi-k3" },
      { id: "auto_approve", value: false },
    ]);
  });
});
