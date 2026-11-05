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

import "~/index.css";

import { render } from "../../../test/render";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ComposerEffortColumn, describeComposerEffort } from "./ComposerModelEffort";
import { ProviderModelPicker } from "./ProviderModelPicker";
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
    planModeEnabled: false,
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
  await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
  const speed = screen.getByRole("button", { name: "Speed: Standard" });
  await expect.element(speed).toHaveFocus();
  await expect.element(page.getByRole("menuitemradio")).not.toBeInTheDocument();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(page.getByRole("menuitemradio", { name: "Standard" })).toHaveFocus();
  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(page.getByRole("menuitemradio")).not.toBeInTheDocument();
  await expect.element(speed).toHaveFocus();

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
  await userEvent.keyboard("{ArrowUp}");
  await expect.element(screen.getByRole("radio", { name: "Medium" })).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}{Enter}");
  await expect
    .element(screen.getByRole("radio", { name: "High" }))
    .toHaveAttribute("aria-checked", "true");
});

it("cycles effort labels inside the picker while keeping search and dismissal independent", async () => {
  const model: ServerProviderModel = {
    slug: "fusion",
    name: "Fusion",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        {
          id: "thought_level",
          label: "Thinking",
          type: "select",
          role: "reasoning",
          currentValue: "balanced",
          promptInjectedValues: ["ultrathink"],
          options: [
            { id: "small", label: "Minimal" },
            { id: "balanced", label: "Medium" },
            { id: "large", label: "Max", isDefault: true },
            { id: "light", label: "Low" },
          ],
        },
        {
          id: "speed",
          label: "Speed",
          type: "select",
          currentValue: "standard",
          options: [{ id: "standard", label: "Standard" }],
        },
      ],
    }),
  };
  const instanceId = ProviderInstanceId.make("devin");
  const entries = deriveProviderInstanceEntries([
    {
      instanceId,
      driver: ProviderDriverKind.make("acpRegistry"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [model],
      slashCommands: [],
      skills: [],
    },
  ]);

  function Picker({ locked = false }: { locked?: boolean }) {
    const [options, setOptions] = useState<ReadonlyArray<ProviderOptionSelection>>([]);
    const traits: TraitsSelectionInput = {
      ...traitsInput(options, (next) => setOptions(next ?? [])),
      models: [model],
      promptUltrathink: locked ? "body" : "none",
    };
    return (
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={instanceId}
        model={model.slug}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={new Map([[instanceId, [model]]])}
        triggerAriaLabel="Choose model"
        onInstanceModelChange={() => {}}
        effortColumn={<ComposerEffortColumn traits={traits} />}
      />
    );
  }

  await using screen = await render(<Picker />);
  await screen.getByRole("button", { name: "Choose model" }).click();
  const search = page.getByPlaceholder("Search models...");
  await userEvent.keyboard("m");
  await expect.element(search).toHaveValue("m");
  await expect.element(search).toHaveFocus();
  await userEvent.clear(search);
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(page.getByRole("radio", { name: "Medium" })).toHaveFocus();

  for (const name of [/^Max/, "Minimal", "Medium"]) {
    await userEvent.keyboard("m");
    await expect.element(page.getByRole("radio", { name, exact: true })).toHaveFocus();
  }
  await userEvent.keyboard("l{Enter}");
  const low = page.getByRole("radio", { name: "Low" });
  await expect.element(low).toHaveFocus();
  await expect.element(low).toHaveAttribute("aria-checked", "true");
  await expect.element(search).toHaveValue("");
  await userEvent.keyboard("{Escape}");
  await expect.element(search).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Choose model" })).toHaveFocus();

  await screen.rerender(<Picker locked />);
  await screen.getByRole("button", { name: "Choose model" }).click();
  await expect.element(low).toBeDisabled();
  await userEvent.keyboard("{ArrowRight}");
  const speed = page.getByRole("button", { name: "Speed: Standard" });
  await expect.element(speed).toHaveFocus();
  const keydown = new KeyboardEvent("keydown", { key: "l", bubbles: true, cancelable: true });
  expect(speed.element().dispatchEvent(keydown)).toBe(true);
  await expect.element(speed).toHaveFocus();
});
