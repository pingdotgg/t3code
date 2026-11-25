import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import {
  ComposerEffortColumn,
  ComposerPickerFooter,
  describeComposerEffort,
} from "./ComposerModelEffort";
import type { TraitsSelectionInput } from "./TraitsPicker";

// Shaped like Devin over ACP: its session mode comes first, and its reasoning id is its own.
const models: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "fusion",
    name: "Fusion (Claude Opus 5.5 Medium + SWE-2 High)",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        {
          id: "mode",
          label: "Session Mode",
          type: "select",
          currentValue: "bypass",
          options: [
            { id: "code", label: "Code" },
            { id: "plan", label: "Plan" },
            { id: "bypass", label: "Bypass Permissions" },
          ],
        },
        {
          id: "thought_level",
          label: "Thinking",
          type: "select",
          role: "reasoning",
          currentValue: "medium",
          options: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
          ],
        },
        {
          id: "speed",
          label: "Speed",
          type: "select",
          currentValue: "standard",
          options: [
            { id: "standard", label: "Standard" },
            { id: "fast", label: "Fast" },
          ],
        },
        { id: "auto_approve", label: "Auto-approve tools", type: "boolean", currentValue: false },
      ],
    }),
  },
];

function traitsInput(
  modelOptions: ReadonlyArray<ProviderOptionSelection>,
  onModelOptionsChange: (next: ReadonlyArray<ProviderOptionSelection> | undefined) => void,
): TraitsSelectionInput {
  return {
    provider: ProviderDriverKind.make("acpRegistry"),
    instanceId: ProviderInstanceId.make("devin"),
    models,
    model: "fusion",
    modelOptions,
    onModelOptionsChange,
  };
}

function Column() {
  const [options, setOptions] = useState<ReadonlyArray<ProviderOptionSelection>>([]);
  const traits = traitsInput(options, (next) => setOptions(next ?? []));
  return (
    <>
      <div data-model-picker-effort>
        <ComposerEffortColumn traits={traits} />
      </div>
      <ComposerPickerFooter
        traits={traits}
        runtimeMode="full-access"
        runtimeModeOptions={[]}
        onRuntimeModeChange={() => {}}
      />
      <p role="status">{describeComposerEffort(traits, "bars", "sm").suffix}</p>
    </>
  );
}

it("draws an agent's reasoning as bars and keeps its mode out of the levels", async () => {
  await using screen = await render(<Column />, { router: false }); // no routes involved
  const status = screen.getByRole("status");
  expect(status.element().querySelector("[data-composer-effort-glyph]")).not.toBeNull();
  await expect.element(status).toHaveTextContent("");

  const levels = screen.getByRole("radiogroup", { name: "Thinking" });
  await expect.element(levels.getByRole("radio")).toHaveLength(3);
  await expect.element(screen.getByRole("radio", { name: "Plan" })).not.toBeInTheDocument();

  // Up and Down walk from the levels through the option rows without opening their menus.
  await userEvent.tab();
  await expect.element(screen.getByRole("radio", { name: "Medium" })).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}{ArrowDown}");
  const mode = screen.getByRole("button", { name: "Session Mode: Bypass Permissions" });
  await expect.element(mode).toHaveFocus();
  await expect.element(page.getByRole("menuitemradio")).not.toBeInTheDocument();
  await userEvent.keyboard("{ArrowRight}");
  await expect
    .element(page.getByRole("menuitemradio", { name: "Bypass Permissions" }))
    .toHaveFocus();
  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(page.getByRole("menuitemradio")).not.toBeInTheDocument();
  await expect.element(mode).toHaveFocus();

  await userEvent.click(screen.getByText("Auto-approve tools"));
  await expect
    .element(screen.getByRole("switch", { name: "Auto-approve tools" }))
    .toHaveAttribute("aria-checked", "true");

  await userEvent.click(screen.getByRole("button", { name: "Session Mode: Bypass Permissions" }));
  await userEvent.click(page.getByRole("menuitemradio", { name: "Plan" }));
  await expect
    .element(screen.getByRole("button", { name: "Session Mode: Plan" }))
    .toBeInTheDocument();
  await expect.element(page.getByRole("menuitemradio")).not.toBeInTheDocument();
});

it("puts an agent's speed option in the footer and marks Fast on the trigger", async () => {
  await using screen = await render(<Column />, { router: false }); // no routes involved
  await expect.element(screen.getByRole("button", { name: /^Speed/ })).not.toBeInTheDocument();
  const speed = screen.getByRole("radiogroup", { name: "Speed" });
  await expect
    .element(speed.getByRole("radio", { name: "Standard" }))
    .toHaveAttribute("aria-checked", "true");
  const status = screen.getByRole("status");
  expect(status.element().querySelector(".lucide-zap")).toBeNull();

  await userEvent.click(speed.getByRole("radio", { name: "Fast" }));
  await expect
    .element(speed.getByRole("radio", { name: "Fast" }))
    .toHaveAttribute("aria-checked", "true");
  expect(status.element().querySelector(".lucide-zap")).not.toBeNull();
});

it("focuses a reasoning level by its first letter without selecting it", async () => {
  await using screen = await render(<Column />, { router: false }); // no routes involved
  await userEvent.tab();
  await expect.element(screen.getByRole("radio", { name: "Medium" })).toHaveFocus();
  await userEvent.keyboard("l");
  await expect.element(screen.getByRole("radio", { name: "Low" })).toHaveFocus();
  await expect
    .element(screen.getByRole("radio", { name: "Medium" }))
    .toHaveAttribute("aria-checked", "true");
  for (const key of ["{Control>}h{/Control}", "{Meta>}h{/Meta}", "{Alt>}h{/Alt}", "{Delete}"]) {
    await userEvent.keyboard(key);
    await expect.element(screen.getByRole("radio", { name: "Low" })).toHaveFocus();
  }
  await userEvent.keyboard("H");
  await expect.element(screen.getByRole("radio", { name: "High" })).toHaveFocus();
  // Wraps past the last level back to the first match.
  await userEvent.keyboard("m");
  await expect.element(screen.getByRole("radio", { name: "Medium" })).toHaveFocus();
  await userEvent.keyboard("h{Enter}");
  await expect
    .element(screen.getByRole("radio", { name: "High" }))
    .toHaveAttribute("aria-checked", "true");
});
