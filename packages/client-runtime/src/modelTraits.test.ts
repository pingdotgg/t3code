import { ProviderDriverKind, type ProviderOptionDescriptor } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildTraitsTriggerDisplay } from "./modelTraits.ts";

describe("buildTraitsTriggerDisplay", () => {
  it("labels Codex cyber access only when a program is chosen", () => {
    const display = (currentValue: string) =>
      buildTraitsTriggerDisplay({
        provider: ProviderDriverKind.make("codex"),
        primarySelectDescriptorId: "reasoningEffort",
        ultrathinkPromptControlled: false,
        descriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [{ id: "medium", label: "Medium", isDefault: true }],
            currentValue: "medium",
          },
          {
            id: "cyberAccessProgram",
            label: "Cyber Access",
            type: "select",
            options: [
              { id: "default", label: "Automatic", isDefault: true },
              { id: "daybreakBlue", label: "Daybreak Blue" },
            ],
            currentValue,
          },
        ] satisfies ReadonlyArray<ProviderOptionDescriptor>,
      }).label;

    expect(display("default")).toBe("Medium");
    expect(display("daybreakBlue")).toBe("Medium · Daybreak Blue");
  });
});
