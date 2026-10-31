import {
  ProviderDriverKind,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ComposerEffortColumn } from "./ComposerModelEffort";
import { readPromptUltrathink } from "./TraitsPicker";

const levels = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium", isDefault: true },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High" },
  { id: "max", label: "Max" },
  { id: "ultra", label: "Ultra" },
];

function EffortMenu({
  options = levels,
  prompt = "",
  thinking = false,
  serviceTiers = 2,
}: {
  options?: typeof levels;
  prompt?: string;
  thinking?: boolean;
  serviceTiers?: 2 | 3;
}) {
  const [modelOptions, setModelOptions] = useState<
    ReadonlyArray<ProviderOptionSelection> | undefined
  >([...(thinking ? [{ id: "thinking", value: true }] : []), { id: "serviceTier", value: "fast" }]);
  const descriptors: ReadonlyArray<ProviderOptionDescriptor> = [
    thinking
      ? {
          id: "thinking",
          label: "Thinking",
          type: "boolean",
          currentValue: true,
        }
      : {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          currentValue: "medium",
          options,
          promptInjectedValues: ["ultrathink"],
        },
    ...(!thinking
      ? [
          {
            id: "contextWindow",
            label: "Context window",
            type: "select" as const,
            currentValue: "normal",
            options: [
              { id: "normal", label: "Normal" },
              { id: "long", label: "Long" },
            ],
          },
        ]
      : []),
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      currentValue: "standard",
      options: [
        { id: "standard", label: "Standard" },
        { id: "fast", label: "Fast" },
        ...(serviceTiers === 3 ? [{ id: "ultrafast", label: "Ultrafast" }] : []),
      ],
    },
  ];
  const models: ReadonlyArray<ServerProviderModel> = [
    {
      slug: "test",
      name: "Test",
      isCustom: false,
      capabilities: { optionDescriptors: descriptors },
    },
  ];
  return (
    <>
      <ComposerEffortColumn
        traits={{
          provider: ProviderDriverKind.make("codex"),
          models,
          model: "test",
          modelOptions,
          onModelOptionsChange: setModelOptions,
          promptUltrathink: readPromptUltrathink(prompt),
          planModeEnabled: true,
        }}
      />
      <output>{JSON.stringify(modelOptions)}</output>
    </>
  );
}

it.each([2, 6])("steps through %i model levels and keeps the other traits", async (count) => {
  const options = levels.slice(0, count);
  // The column has no routing behavior.
  await using screen = await render(<EffortMenu options={options} />, { router: false });
  await userEvent.tab();
  const slider = page.getByRole("slider", { name: "Reasoning" });
  await expect.element(slider).toHaveFocus();
  await expect.element(slider).toHaveAttribute("max", String(count - 1));
  await expect.element(slider).toHaveAttribute("aria-valuetext", "Medium (default)");

  await userEvent.keyboard("{Home}");
  for (const [index, option] of options.entries()) {
    if (index > 0) await userEvent.keyboard("{ArrowRight}");
    await expect
      .element(slider)
      .toHaveAttribute("aria-valuetext", `${option.label}${option.isDefault ? " (default)" : ""}`);
    await expect.element(screen.getByRole("status")).toHaveTextContent(
      JSON.stringify([
        { id: "reasoningEffort", value: option.id },
        { id: "contextWindow", value: "normal" },
        { id: "serviceTier", value: "fast" },
      ]),
    );
  }
  await userEvent.keyboard("{ArrowLeft}{End}");
  await expect.element(slider).toHaveValue(String(count - 1));
  await userEvent.keyboard("{ArrowDown}");
  await expect.element(page.getByRole("radio", { name: "Normal" })).toHaveFocus();
  await userEvent.keyboard("{ArrowUp}");
  await expect.element(slider).toHaveFocus();
});

it("toggles boolean Thinking both ways while preserving Service Tier", async () => {
  // The column has no routing behavior.
  await using screen = await render(<EffortMenu thinking />, { router: false });
  await userEvent.tab();
  const toggle = page.getByRole("switch", { name: "Thinking" });
  await expect.element(toggle).toHaveFocus();
  await expect.element(toggle).toHaveAttribute("aria-checked", "true");
  await userEvent.keyboard(" ");
  await expect.element(toggle).toHaveAttribute("aria-checked", "false");
  await expect.element(screen.getByRole("status")).toHaveTextContent(
    JSON.stringify([
      { id: "thinking", value: false },
      { id: "serviceTier", value: "fast" },
    ]),
  );
  await userEvent.keyboard(" ");
  await expect.element(toggle).toHaveAttribute("aria-checked", "true");
});

it("keeps prompt-controlled Ultrathink disabled", async () => {
  const options = [...levels, { id: "ultrathink", label: "Ultrathink" }];
  // The column has no routing behavior.
  await using screen = await render(
    <EffortMenu options={options} prompt="Please ultrathink about this" />,
    {
      router: false,
    },
  );
  await expect.element(screen.getByRole("slider", { name: "Reasoning" })).toBeDisabled();
  await expect
    .element(screen.getByRole("slider", { name: "Reasoning" }))
    .toHaveAttribute("aria-valuetext", "Ultrathink");
});
