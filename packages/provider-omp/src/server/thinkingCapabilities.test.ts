import { expect, it } from "@effect/vitest";
import { thinkingCapabilitiesForOmpModel } from "./thinkingCapabilities.ts";
it("uses OMP thinking.efforts without inventing unsupported levels", () => {
  const capabilities = thinkingCapabilitiesForOmpModel(
    { reasoning: true, thinking: { efforts: ["low", "high", "max"] } },
    "high",
  );
  const thinking = capabilities.optionDescriptors?.[0];
  expect(thinking?.type === "select" ? thinking.options.map((option) => option.id) : []).toEqual([
    "low",
    "high",
    "max",
  ]);
  expect(thinkingCapabilitiesForOmpModel({ reasoning: true }, undefined).optionDescriptors).toEqual(
    [],
  );
});
