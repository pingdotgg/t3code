import { ProviderInstanceId, type SelectProviderOptionDescriptor } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";

import { resolveDefaultChoiceId } from "./modelTraits.ts";

const claude = ProviderInstanceId.make("claudeAgent");
const effort: SelectProviderOptionDescriptor = {
  id: "effort",
  label: "Reasoning",
  type: "select",
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium", isDefault: true },
    { id: "high", label: "High" },
    { id: "ultrathink", label: "Ultrathink" },
  ],
  promptInjectedValues: ["ultrathink"],
};
const opus = { instanceId: claude, model: "claude-opus-5-5" };

describe("resolveDefaultChoiceId", () => {
  it("marks the configured default's level, falling back to the provider's default", () => {
    const configured = (instanceId: ProviderInstanceId, model: string, value: string) =>
      createModelSelection(instanceId, model, [{ id: "effort", value }]);
    const work = ProviderInstanceId.make("claudeAgent_work");

    expect(resolveDefaultChoiceId(effort, opus, configured(claude, opus.model, "high"))).toBe(
      "high",
    );
    expect(
      resolveDefaultChoiceId(effort, opus, configured(claude, "claude-fable-5-1", "high")),
    ).toBe("medium");
    expect(resolveDefaultChoiceId(effort, opus, configured(work, opus.model, "high"))).toBe(
      "medium",
    );
    expect(resolveDefaultChoiceId(effort, opus, configured(claude, opus.model, "ultrathink"))).toBe(
      "medium",
    );
  });
});
