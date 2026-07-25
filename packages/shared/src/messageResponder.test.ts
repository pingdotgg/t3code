import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";

import { describeMessageResponder, type MessageResponderProvider } from "./messageResponder.ts";
import { createModelCapabilities, createModelSelection } from "./model.ts";

const codexModel: ServerProviderModel = {
  slug: "gpt-5.3-codex",
  name: "GPT-5.3 Codex",
  isCustom: false,
  capabilities: createModelCapabilities({
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
          { id: "xhigh", label: "Extra High" },
        ],
      },
    ],
  }),
};

const providers: ReadonlyArray<MessageResponderProvider> = [
  {
    instanceId: "codex",
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex",
    models: [codexModel],
  },
];

function responderFor(options: ReadonlyArray<{ id: string; value: string }>) {
  return {
    modelSelection: createModelSelection(
      ProviderInstanceId.make("codex"),
      codexModel.slug,
      options,
    ),
  };
}

describe("describeMessageResponder", () => {
  it("labels the model, its effort, and the provider behind it", () => {
    const display = describeMessageResponder({
      responder: responderFor([{ id: "reasoningEffort", value: "xhigh" }]),
      providers,
    });

    expect(display).toEqual({
      model: "GPT-5.3 Codex",
      effort: "Extra High",
      driver: "codex",
      providerName: "Codex",
      accentColor: undefined,
    });
  });

  it("names the resolved effort behind auto", () => {
    const display = describeMessageResponder({
      responder: {
        ...responderFor([{ id: "reasoningEffort", value: "high" }]),
        autoEffort: true,
      },
      providers,
    });

    expect(display?.effort).toBe("Auto (High)");
  });

  it("falls back to the model slug for models the server no longer reports", () => {
    const display = describeMessageResponder({
      responder: responderFor([{ id: "reasoningEffort", value: "high" }]),
      providers: [],
    });

    expect(display).toEqual({
      model: "gpt-5.3-codex",
      effort: null,
      driver: null,
      providerName: "codex",
      accentColor: undefined,
    });
  });

  it("omits the effort for models without one", () => {
    const display = describeMessageResponder({
      responder: responderFor([]),
      providers,
    });

    expect(display?.model).toBe("GPT-5.3 Codex");
    expect(display?.effort).toBeNull();
  });

  it("returns nothing for messages recorded before responders were tracked", () => {
    expect(describeMessageResponder({ responder: undefined, providers })).toBeNull();
  });
});
