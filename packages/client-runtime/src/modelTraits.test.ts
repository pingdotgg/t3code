import { describe, expect, it } from "vite-plus/test";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  type ProviderOptionDescriptor,
} from "@t3tools/contracts";
import {
  decideDaybreakModelChange,
  getModelTraitDescriptors,
  visibleModelTraitDescriptors,
  buildTraitsTriggerDisplay,
  getTraitSelectChange,
  getPromptControlledTraits,
  preserveExplicitDaybreakOption,
} from "./modelTraits.ts";

const instanceId = ProviderInstanceId.make("codex");
const target = {
  instanceId,
  model: "target",
  options: [{ id: "cyberAccessProgram", value: "daybreakRed" }],
};
const red = [{ id: "cyberAccessProgram", value: "daybreakRed" }];
function programs(...ids: string[]): ReadonlyArray<ProviderOptionDescriptor> {
  return [
    {
      id: "cyberAccessProgram",
      label: "Daybreak",
      type: "select",
      options: ids.map((id) => ({ id, label: id })),
    },
  ];
}

describe("Daybreak model changes", () => {
  it.each([{ descriptors: [] }, { descriptors: programs("standard", "daybreakBlue") }])(
    "preserves model-only updates when no Daybreak value needs changing (%j)",
    ({ descriptors }) => {
      const modelOnly = { instanceId, model: "target" };
      for (const current of [undefined, [{ id: "cyberAccessProgram", value: "standard" }]]) {
        const result = decideDaybreakModelChange(current, modelOnly, descriptors);
        expect(result).toEqual({ type: "ready", selection: modelOnly });
        if (result.type === "ready") expect(result.selection).not.toHaveProperty("options");
      }
    },
  );
  it("offers only Blue and advertised Off when Red cannot carry", () => {
    const decision = decideDaybreakModelChange(red, target, programs("standard", "daybreakBlue"));
    expect(decision.type).toBe("confirm");
    if (decision.type !== "confirm") return;
    expect(decision.choices.map((choice) => choice.label)).toEqual(["Use Blue", "Turn Off"]);
    expect(decision.choices.map((choice) => choice.selection.options)).toEqual([
      [{ id: "cyberAccessProgram", value: "daybreakBlue" }],
      [{ id: "cyberAccessProgram", value: "standard" }],
    ]);
    expect(red).toEqual([{ id: "cyberAccessProgram", value: "daybreakRed" }]);
    expect(target.options).toEqual(red);
  });
  it("does not invent Off when standard is absent", () => {
    const decision = decideDaybreakModelChange(red, target, programs("daybreakBlue"));
    expect(decision.type === "confirm" && decision.choices.map((choice) => choice.label)).toEqual([
      "Use Blue",
    ]);
  });
  it("offers clearing the option for a target without a capability descriptor", () => {
    const decision = decideDaybreakModelChange(red, target, []);
    expect(decision.type === "confirm" && decision.choices).toEqual([
      { label: "Turn Off", selection: { ...target, options: [] } },
    ]);
  });
  it("preserves the active program over the target sticky choice", () => {
    const blue = [{ id: "cyberAccessProgram", value: "daybreakBlue" }];
    expect(
      decideDaybreakModelChange(blue, target, programs("standard", "daybreakBlue", "daybreakRed")),
    ).toEqual({
      type: "ready",
      selection: { ...target, options: blue },
    });
  });
  it("requires an explicit advertised program when moving from Off to a color-only model", () => {
    const decision = decideDaybreakModelChange(undefined, target, programs("daybreakBlue"));
    expect(decision.type === "confirm" && decision.choices.map((choice) => choice.label)).toEqual([
      "Use Blue",
    ]);
  });
  it("never resurrects a remembered active program when the current program is Off", () => {
    expect(
      decideDaybreakModelChange(
        [{ id: "cyberAccessProgram", value: "standard" }],
        target,
        programs("standard", "daybreakRed"),
      ),
    ).toEqual({
      type: "ready",
      selection: { ...target, options: [{ id: "cyberAccessProgram", value: "standard" }] },
    });
  });
});

describe("Daybreak traits", () => {
  it("hides the control without Blue or Red and shows only advertised choices", () => {
    expect(visibleModelTraitDescriptors(programs("standard"))).toEqual([]);
    expect(visibleModelTraitDescriptors(programs("standard", "daybreakBlue"))).toEqual(
      programs("standard", "daybreakBlue"),
    );
  });
  it("keeps advertised Off reachable when the active program is revoked", () => {
    const descriptors = getModelTraitDescriptors({
      caps: { optionDescriptors: programs("standard") },
      selections: red,
    });
    expect(visibleModelTraitDescriptors(descriptors)).toEqual(descriptors);
    const descriptor = descriptors[0];
    if (descriptor?.type !== "select") throw new Error("Missing Daybreak descriptor");
    expect(descriptor.options.map((option) => option.id)).toEqual(["standard"]);
  });
  it("uses plain Daybreak names and leaves Off out of the summary", () => {
    const display = (value: string) =>
      buildTraitsTriggerDisplay({
        provider: ProviderDriverKind.make("codex"),
        descriptors: getModelTraitDescriptors({
          caps: { optionDescriptors: programs("standard", "daybreakBlue") },
          selections: [{ id: "cyberAccessProgram", value }],
        }),
        primarySelectDescriptorId: null,
        ultrathinkPromptControlled: false,
      });
    expect(display("standard").label).toBe("");
    expect(display("daybreakBlue").label).toBe("Daybreak Blue");
  });
  it("preserves explicit revoked programs for backend validation and other trait edits", () => {
    const descriptors = getModelTraitDescriptors({
      caps: {
        optionDescriptors: [
          ...programs("standard", "daybreakBlue"),
          {
            id: "reasoningEffort",
            label: "Effort",
            type: "select",
            options: [
              { id: "high", label: "High" },
              { id: "low", label: "Low" },
            ],
          },
        ],
      },
      selections: red,
    });
    const effort = descriptors.find((descriptor) => descriptor.id === "reasoningEffort");
    if (effort?.type !== "select") throw new Error("Missing effort");
    expect(
      getTraitSelectChange(
        { ...getPromptControlledTraits(descriptors, ""), descriptors },
        effort,
        "prompt",
        "high",
      ),
    ).toMatchObject({ modelOptions: expect.arrayContaining(red) });
    expect(preserveExplicitDaybreakOption(undefined, red)).toEqual(red);
    const missingDescriptors = descriptors.filter(
      (descriptor) => descriptor.id !== "cyberAccessProgram",
    );
    expect(
      getTraitSelectChange(
        {
          ...getPromptControlledTraits(missingDescriptors, ""),
          descriptors: missingDescriptors,
          modelOptions: red,
        },
        effort,
        "prompt",
        "high",
      ),
    ).toMatchObject({ modelOptions: expect.arrayContaining(red) });
  });
});
