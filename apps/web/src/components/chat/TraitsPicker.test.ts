import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type ProviderOptionDescriptor } from "@t3tools/contracts";
import {
  buildTraitsTriggerDisplay,
  LOCKED_PROVIDER_OPTION_TOAST,
  resolveProviderOptionChange,
} from "./TraitsPicker";

function selectDescriptor(
  id: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
  currentValue: string,
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  return { id, label: id, type: "select", options: [...options], currentValue };
}

function fastModeDescriptor(
  currentValue: boolean,
): Extract<ProviderOptionDescriptor, { type: "boolean" }> {
  return { id: "fastMode", label: "Fast Mode", type: "boolean", currentValue };
}

const EFFORT = selectDescriptor(
  "reasoningEffort",
  [
    { id: "high", label: "High" },
    { id: "max", label: "Max" },
  ],
  "high",
);
const CONTEXT_WINDOW = selectDescriptor(
  "contextWindow",
  [
    { id: "200k", label: "200k" },
    { id: "1m", label: "1M" },
  ],
  "1m",
);

const CODEX = ProviderDriverKind.make("codex");

function display(descriptors: ReadonlyArray<ProviderOptionDescriptor>) {
  return buildTraitsTriggerDisplay({
    provider: CODEX,
    descriptors,
    primarySelectDescriptorId: "reasoningEffort",
    ultrathinkPromptControlled: false,
  });
}

describe("resolveProviderOptionChange", () => {
  it("ignores re-selecting the current select value (locked or unlocked)", () => {
    expect(
      resolveProviderOptionChange({
        descriptors: [EFFORT, CONTEXT_WINDOW],
        descriptorId: "reasoningEffort",
        nextValue: "high",
        optionChangeBlocked: true,
      }),
    ).toEqual({ action: "ignore" });
  });

  it("ignores re-selecting the current boolean value", () => {
    expect(
      resolveProviderOptionChange({
        descriptors: [fastModeDescriptor(true)],
        descriptorId: "fastMode",
        nextValue: true,
        optionChangeBlocked: false,
      }),
    ).toEqual({ action: "ignore" });
  });

  it("ignores currentValue ultrathink re-select even when the descriptor store differs", () => {
    // Prompt-controlled ultrathink uses currentValue while the descriptor may still
    // hold the sticky session value (e.g. "high"). Same-value clicks must stay silent.
    expect(
      resolveProviderOptionChange({
        descriptors: [EFFORT],
        descriptorId: "reasoningEffort",
        nextValue: "ultrathink",
        optionChangeBlocked: true,
        currentValue: "ultrathink",
      }),
    ).toEqual({ action: "ignore" });
  });

  it("warns for a locked select change with no next descriptors", () => {
    expect(
      resolveProviderOptionChange({
        descriptors: [EFFORT, CONTEXT_WINDOW],
        descriptorId: "reasoningEffort",
        nextValue: "max",
        optionChangeBlocked: true,
      }),
    ).toEqual({ action: "warn", toast: LOCKED_PROVIDER_OPTION_TOAST });
  });

  it("warns for a locked boolean change with no next descriptors", () => {
    expect(
      resolveProviderOptionChange({
        descriptors: [fastModeDescriptor(false)],
        descriptorId: "fastMode",
        nextValue: true,
        optionChangeBlocked: true,
      }),
    ).toEqual({ action: "warn", toast: LOCKED_PROVIDER_OPTION_TOAST });
  });

  it("returns next descriptors for an unlocked select change", () => {
    expect(
      resolveProviderOptionChange({
        descriptors: [EFFORT, CONTEXT_WINDOW],
        descriptorId: "reasoningEffort",
        nextValue: "max",
        optionChangeBlocked: false,
      }),
    ).toEqual({
      action: "apply",
      nextDescriptors: [{ ...EFFORT, currentValue: "max" }, CONTEXT_WINDOW],
    });
  });

  it("returns next descriptors for an unlocked boolean change", () => {
    expect(
      resolveProviderOptionChange({
        descriptors: [EFFORT, fastModeDescriptor(false)],
        descriptorId: "fastMode",
        nextValue: true,
        optionChangeBlocked: false,
      }),
    ).toEqual({
      action: "apply",
      nextDescriptors: [EFFORT, fastModeDescriptor(true)],
    });
  });
});

describe("buildTraitsTriggerDisplay", () => {
  it("omits fast mode from the label entirely when it is off", () => {
    expect(display([EFFORT, fastModeDescriptor(false), CONTEXT_WINDOW])).toEqual({
      label: "High · 1M",
      showFastModeIcon: false,
    });
  });

  it("shows the bolt instead of a text label when fast mode is on", () => {
    expect(display([EFFORT, fastModeDescriptor(true), CONTEXT_WINDOW])).toEqual({
      label: "High · 1M",
      showFastModeIcon: true,
    });
  });

  it("renders Codex's Standard and Fast service tiers as fast mode", () => {
    const serviceTier = selectDescriptor(
      "serviceTier",
      [
        { id: "default", label: "Standard", isDefault: true },
        { id: "priority", label: "Fast" },
      ],
      "default",
    );

    expect(display([EFFORT, serviceTier])).toEqual({
      label: "High",
      showFastModeIcon: false,
    });
    expect(display([EFFORT, { ...serviceTier, currentValue: "priority" }])).toEqual({
      label: "High",
      showFastModeIcon: true,
    });
  });

  it("keeps non-fastMode booleans as text labels", () => {
    const thinking: Extract<ProviderOptionDescriptor, { type: "boolean" }> = {
      id: "thinking",
      label: "Thinking",
      type: "boolean",
      currentValue: true,
    };
    expect(display([EFFORT, thinking])).toEqual({
      label: "High · Thinking On",
      showFastModeIcon: false,
    });
  });

  it("falls back to a text label when fast mode is the only trait", () => {
    expect(display([fastModeDescriptor(true)])).toEqual({
      label: "Fast",
      showFastModeIcon: false,
    });
    expect(display([fastModeDescriptor(false)])).toEqual({
      label: "Normal",
      showFastModeIcon: false,
    });
  });

  it("stays blank when descriptors resolve to no label and there is no fast mode", () => {
    // A select with neither a currentValue nor an isDefault option yields no
    // label. Without a fastMode descriptor present that must stay blank rather
    // than falling through to a bogus "Normal".
    const unresolved: Extract<ProviderOptionDescriptor, { type: "select" }> = {
      id: "effort",
      label: "effort",
      type: "select",
      options: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    };
    expect(display([unresolved])).toEqual({ label: "", showFastModeIcon: false });
  });

  it("still renders the prompt-controlled ultrathink label alongside the bolt", () => {
    expect(
      buildTraitsTriggerDisplay({
        provider: CODEX,
        descriptors: [EFFORT, fastModeDescriptor(true)],
        primarySelectDescriptorId: "reasoningEffort",
        ultrathinkPromptControlled: true,
      }),
    ).toEqual({ label: "Ultrathink", showFastModeIcon: true });
  });
});
