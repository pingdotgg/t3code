import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { getProviderOptionDescriptors } from "@t3tools/shared/model";
import { expect, it } from "vite-plus/test";

import { buildTraitsTriggerDisplay } from "./modelTraits.ts";

it.each([
  { reported: true, explicit: undefined, expected: true },
  { reported: false, explicit: undefined, expected: false },
  { reported: true, explicit: false, expected: false },
  { reported: false, explicit: true, expected: true },
])("resolves thinking labels from reported $reported and explicit $explicit", (input) => {
  const modelSelection = {
    instanceId: ProviderInstanceId.make("claude"),
    model: "thinking-model",
    options: input.explicit === undefined ? [] : [{ id: "thinking", value: input.explicit }],
  };
  const descriptors = getProviderOptionDescriptors({
    caps: {
      optionDescriptors: [
        { id: "thinking", label: "Thinking", type: "boolean", currentValue: !input.reported },
      ],
    },
    selections: modelSelection.options,
  });
  const label = `Thinking ${input.expected ? "On" : "Off"}`;

  expect(
    buildTraitsTriggerDisplay({
      provider: ProviderDriverKind.make("claudeAgent"),
      descriptors,
      primarySelectDescriptorId: null,
      ultrathinkPromptControlled: false,
      modelSelection,
      reportedModelSelection: {
        ...modelSelection,
        options: [{ id: "thinking", value: input.reported }],
      },
    }),
  ).toEqual({ label, speedLabel: null, otherLabels: [label] });
});
