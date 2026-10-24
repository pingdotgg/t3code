import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type ProviderOptionDescriptor } from "@t3tools/contracts";
import { buildTraitsTriggerDisplay } from "./modelTraits.ts";

describe("thinking trait label", () => {
  const display = (
    descriptors: ProviderOptionDescriptor[],
    provider = ProviderDriverKind.make("claudeAgent"),
  ) =>
    buildTraitsTriggerDisplay({
      provider,
      descriptors,
      primarySelectDescriptorId: "effort",
      ultrathinkPromptControlled: false,
    }).label;

  it("keeps default thinking out of the normal effort and context label", () => {
    expect(
      display([
        {
          id: "effort",
          label: "Reasoning",
          type: "select",
          options: [{ id: "high", label: "High", isDefault: true }],
        },
        { id: "thinking", label: "Thinking", type: "boolean", currentValue: true },
        {
          id: "contextWindow",
          label: "Context Window",
          type: "select",
          options: [{ id: "200k", label: "200k", isDefault: true }],
        },
      ]),
    ).toBe("High · 200k");
  });

  it("keeps a visible label when thinking is the only control", () => {
    expect(
      display([{ id: "thinking", label: "Thinking", type: "boolean", currentValue: true }]),
    ).toBe("Thinking");
  });

  it("shows an explicit thinking-off choice", () => {
    expect(
      display([{ id: "thinking", label: "Thinking", type: "boolean", currentValue: false }]),
    ).toBe("Thinking Off");
  });

  it.each([true, false])("shows Cursor's thinking selection when it is %s", (thinking) => {
    const descriptor: ProviderOptionDescriptor = {
      id: "thinking",
      label: "Thinking",
      type: "boolean",
      currentValue: thinking,
    };
    const label = thinking ? "Thinking On" : "Thinking Off";
    expect(display([descriptor], ProviderDriverKind.make("cursor"))).toBe(label);
    expect(
      display(
        [
          {
            id: "effort",
            label: "Reasoning",
            type: "select",
            options: [{ id: "high", label: "High", isDefault: true }],
          },
          descriptor,
        ],
        ProviderDriverKind.make("cursor"),
      ),
    ).toBe(`High · ${label}`);
  });
});
