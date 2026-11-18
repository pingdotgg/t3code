import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderModelPicker } from "./ProviderModelPicker";

const instanceId = ProviderInstanceId.make("codex");

function Picker({ keybindings = [] }: { keybindings?: ResolvedKeybindingsConfig }) {
  const [model, setModel] = useState("original");
  return (
    <>
      <output aria-label="Selected model">{model}</output>
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={instanceId}
        model={model}
        lockedProvider={null}
        instanceEntries={deriveProviderInstanceEntries([
          {
            instanceId,
            driver: ProviderDriverKind.make("codex"),
            enabled: true,
            installed: true,
            version: null,
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: "2026-01-01T00:00:00.000Z",
            models: [],
            slashCommands: [],
            skills: [],
          },
        ])}
        keybindings={keybindings}
        modelOptionsByInstance={
          new Map([
            [
              instanceId,
              [
                { slug: "original", name: "Original model" },
                { slug: "target", name: "Target model" },
              ],
            ],
          ])
        }
        triggerAriaLabel="Choose model"
        onInstanceModelChange={(_, selected) => setModel(selected)}
      />
    </>
  );
}

it("keeps composition keys out of model selection and dismissal", async () => {
  await using screen = await render(<Picker />);
  await page.getByRole("button", { name: "Choose model" }).click();
  const search = page.getByPlaceholder("Search models...");
  await search.fill("Target");
  await expect.element(page.getByRole("option", { name: /Target model/ })).toBeVisible();

  for (const nativeEvent of [{ isComposing: true }, { keyCode: 229 }]) {
    for (const key of ["Enter", "Escape"]) {
      const event = new KeyboardEvent("keydown", {
        key,
        ...nativeEvent,
        bubbles: true,
        cancelable: true,
      });
      await act(() => search.element().dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
      await expect.element(search).toBeVisible();
      await expect
        .element(screen.getByRole("status", { name: "Selected model" }))
        .toHaveTextContent("original");
    }
  }

  await userEvent.keyboard("{Enter}");
  await expect.element(search).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("status", { name: "Selected model" }))
    .toHaveTextContent("target");
  await page.getByRole("button", { name: "Choose model" }).click();
  await expect.element(search).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(search).not.toBeInTheDocument();
});

it("keeps composing keys from triggering model jump shortcuts", async () => {
  const keybindings = compileResolvedKeybindingsConfig([
    { key: "enter", command: "modelPicker.jump.1", when: "modelPickerOpen" },
  ]);
  await using screen = await render(<Picker keybindings={keybindings} />);
  await page.getByRole("button", { name: "Choose model" }).click();
  const search = page.getByPlaceholder("Search models...");
  await search.fill("Target");
  await expect.element(page.getByRole("option", { name: /Target model/ })).toBeVisible();

  for (const nativeEvent of [{ isComposing: true }, { keyCode: 229 }]) {
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      ...nativeEvent,
      bubbles: true,
      cancelable: true,
    });
    await act(() => search.element().dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    await expect.element(search).toBeVisible();
    await expect
      .element(screen.getByRole("status", { name: "Selected model" }))
      .toHaveTextContent("original");
  }
});
