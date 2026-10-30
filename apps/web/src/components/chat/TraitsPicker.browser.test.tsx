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
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { readPromptUltrathink, TraitsMenuContent } from "./TraitsPicker";

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
      <Menu>
        <MenuTrigger>Effort</MenuTrigger>
        <MenuPopup>
          <TraitsMenuContent
            provider={ProviderDriverKind.make("codex")}
            models={models}
            model="test"
            modelOptions={modelOptions}
            onModelOptionsChange={setModelOptions}
            promptUltrathink={readPromptUltrathink(prompt)}
            planModeEnabled
            isComposerOwned
          />
        </MenuPopup>
      </Menu>
      <output>{JSON.stringify(modelOptions)}</output>
    </>
  );
}

it.each([2, 6])(
  "steps through %i model levels and keeps the other traits and menu navigation",
  async (count) => {
    const options = levels.slice(0, count);
    // The menu has no routing behavior.
    await using screen = await render(<EffortMenu options={options} />, { router: false });
    await userEvent.tab();
    await userEvent.keyboard("{ArrowDown}");
    const slider = page.getByRole("slider", { name: "Reasoning" });
    await expect.element(slider).toHaveFocus();
    await expect.element(slider).toHaveAttribute("max", String(count - 1));
    await expect.element(slider).toHaveAttribute("aria-valuetext", "Medium (default)");

    await userEvent.keyboard("{Home}");
    for (const [index, option] of options.entries()) {
      if (index > 0) await userEvent.keyboard("{ArrowRight}");
      await expect
        .element(slider)
        .toHaveAttribute(
          "aria-valuetext",
          `${option.label}${option.isDefault ? " (default)" : ""}`,
        );
      await expect.element(screen.getByRole("status")).toHaveTextContent(
        JSON.stringify([
          { id: "reasoningEffort", value: option.id },
          { id: "serviceTier", value: "fast" },
        ]),
      );
    }
    await userEvent.keyboard("{ArrowLeft}{End}");
    await expect.element(slider).toHaveValue(String(count - 1));
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(page.getByRole("menuitemradio", { name: "Standard" })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(page.getByRole("menuitemradio", { name: "Fast" })).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    await userEvent.keyboard("{ArrowUp}");
    await expect.element(slider).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect.element(screen.getByRole("button", { name: "Effort" })).toHaveFocus();
  },
);

it.each([2, 3] as const)(
  "changes between %i service tiers without closing the menu or losing reasoning",
  async (count) => {
    // The menu has no routing behavior.
    await using screen = await render(<EffortMenu serviceTiers={count} />, {
      router: false,
    });
    await userEvent.tab();
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(page.getByRole("slider", { name: "Reasoning" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(page.getByRole("menuitemradio", { name: "Standard" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("menuitemradio", { name: "Standard" })).toBeVisible();
    await expect.element(page.getByRole("menuitemradio", { name: "Standard" })).toHaveFocus();
    await userEvent.keyboard(count === 3 ? "{ArrowRight}{ArrowRight}" : "{ArrowRight}");
    const selectedTier = page.getByRole("menuitemradio", {
      name: count === 3 ? "Ultrafast" : "Fast",
    });
    await expect.element(selectedTier).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect.element(selectedTier).toHaveAttribute("aria-checked", "true");
    await expect.element(screen.getByRole("status")).toHaveTextContent(
      JSON.stringify([
        { id: "reasoningEffort", value: "medium" },
        { id: "serviceTier", value: count === 3 ? "ultrafast" : "fast" },
      ]),
    );
  },
);

it("toggles boolean Thinking both ways while preserving Service Tier", async () => {
  // The menu has no routing behavior.
  await using screen = await render(<EffortMenu thinking />, { router: false });
  await userEvent.tab();
  await userEvent.keyboard("{ArrowDown}");
  const toggle = page.getByRole("menuitemcheckbox", { name: "Thinking" });
  await expect.element(toggle).toHaveFocus();
  await expect.element(toggle).toHaveAttribute("aria-checked", "true");
  await userEvent.keyboard("{Enter}");
  await expect.element(toggle).toHaveAttribute("aria-checked", "false");
  await expect.element(screen.getByRole("status")).toHaveTextContent(
    JSON.stringify([
      { id: "thinking", value: false },
      { id: "serviceTier", value: "fast" },
    ]),
  );
  await userEvent.click(toggle);
  await expect.element(toggle).toHaveAttribute("aria-checked", "true");
});

it("keeps prompt-controlled Ultrathink disabled", async () => {
  const options = [...levels, { id: "ultrathink", label: "Ultrathink" }];
  // The menu has no routing behavior.
  await using screen = await render(
    <EffortMenu options={options} prompt="Please ultrathink about this" />,
    {
      router: false,
    },
  );
  await userEvent.click(screen.getByRole("button", { name: "Effort" }));
  await expect.element(page.getByRole("slider", { name: "Reasoning" })).toBeDisabled();
  await expect
    .element(page.getByRole("slider", { name: "Reasoning" }))
    .toHaveAttribute("aria-valuetext", "Ultrathink");
});
