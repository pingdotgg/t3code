import { RegistryProvider } from "@effect/atom-react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent, type Locator } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import * as atomCommands from "../../state/use-atom-command";

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
  useEnvironmentsWithScope: ((environments: ReadonlyArray<{ environmentId: string }>) =>
    new Set(environments.map(({ environmentId }) => environmentId))) as never,
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: vi.fn(() => vi.fn()) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => {
    const environment = {
      environmentId: "env",
      label: "Build workstation",
      serverConfig: {
        keybindings: compileResolvedKeybindingsConfig([
          { command: "script.run-tests.run", key: "mod+r" },
        ]),
        keybindingsConfigPath: null,
        availableEditors: [],
      },
    };
    return {
      scope: { kind: "environment" },
      environment,
      environments: [environment],
      connectedEnvironments: [environment],
      targets: [],
      target: null,
    };
  }) as never,
}));

import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { KeybindingsSettingsPanel } from "./KeybindingsSettings";

// The modal dialog's inert layer swallows pointer events in this harness, so drive the DOM.
async function activate(locator: Locator, action: "click" | "focus") {
  await expect.element(locator).toBeVisible();
  (locator.element() as HTMLElement)[action]();
}

const existingField = page.getByRole("textbox", { name: "Keybinding for Sidebar: Toggle" });
const existingPill = page.getByRole("button", { name: /^Edit shortcut for Sidebar: Toggle:/ });
const newField = page.getByRole("textbox", { name: "Keybinding for new keybinding" });

describe("Esc in a shortcut recorder", () => {
  it.each<{
    name: string;
    field: Locator;
    open: () => Promise<void>;
    expectReset: () => Promise<void>;
  }>([
    {
      name: "existing binding",
      field: existingField,
      open: () => activate(existingPill, "click"),
      expectReset: async () => {
        await expect.element(existingField).not.toBeInTheDocument();
        await expect.element(existingPill).toHaveFocus();
        await expect.element(page.getByRole("button", { name: "Save" })).not.toBeInTheDocument();
      },
    },
    {
      name: "new binding",
      field: newField,
      open: async () => {
        await activate(page.getByRole("button", { name: "Add keybinding" }), "click");
        await activate(newField, "focus");
      },
      expectReset: async () => {
        await expect.element(newField).toHaveValue("");
        await expect.element(newField).toHaveAttribute("placeholder", "Unassigned");
      },
    },
  ])("leaves the $name field without closing Settings", async ({ field, open, expectReset }) => {
    const onOpenChange = vi.fn();
    await using _screen = await render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogPopup>
          <DialogTitle>Settings</DialogTitle>
          <KeybindingsSettingsPanel />
        </DialogPopup>
      </Dialog>,
    );

    await open();
    await userEvent.keyboard("{Control>}k{/Control}");
    await expect.element(field).not.toHaveValue("");
    await userEvent.tab();
    await activate(field, "focus");
    await expect.element(field).toHaveAttribute("placeholder", "Press shortcut");

    await userEvent.keyboard("{Escape}");

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(document.activeElement?.matches("[data-keybinding-capture]")).toBe(false);
    await expectReset();

    await userEvent.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything());
  });
});

it("shows Unassign only while recording and keeps it clickable without blurring the recorder", async () => {
  const mutate = vi.fn(async () => ({ _tag: "Success", value: [] }));
  await vi.mocked(atomCommands.useAtomCommand).withImplementation(
    () => mutate as never,
    async () => {
      await using screen = await render(<KeybindingsSettingsPanel />);
      const remove = screen.getByRole("button", { name: "Unassign shortcut for Sidebar: Toggle" });
      const field = screen.getByRole("textbox", { name: "Keybinding for Sidebar: Toggle" });
      const pill = screen.getByRole("button", { name: /^Edit shortcut for Sidebar: Toggle:/ });

      await expect.element(remove).not.toBeInTheDocument();
      await pill.click();
      await expect.element(field).toHaveAttribute("placeholder", "Press shortcut");
      await expect.element(remove).toBeVisible();
      await userEvent.keyboard("{Escape}");
      await expect.element(remove).not.toBeInTheDocument();
      await pill.click();
      await remove.click();

      expect(mutate).toHaveBeenCalledTimes(1);
      expect(mutate).toHaveBeenCalledWith({
        environmentId: "env",
        input: {
          command: "sidebar.toggle",
          key: "mod+b",
          when: "false",
          replace: { command: "sidebar.toggle", key: "mod+b" },
        },
      });
      await expect.element(field).toHaveFocus();
      await userEvent.keyboard("{Escape}");
      await screen
        .getByRole("button", { name: /^Edit shortcut for Run Script: Run Tests:/ })
        .click();
      await expect
        .element(
          screen.getByRole("button", { name: "Unassign shortcut for Run Script: Run Tests" }),
        )
        .not.toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      await screen.getByRole("button", { name: "Actions for Run Script: Run Tests" }).click();
      await screen.getByRole("menuitem", { name: "Remove", exact: true }).click();
      expect(mutate).toHaveBeenLastCalledWith({
        environmentId: "env",
        input: { command: "script.run-tests.run", key: "mod+r" },
      });
    },
  );
});

it("re-enables Save when a When editor closes on an expression it could not parse", async () => {
  await using screen = await render(
    <RegistryProvider>
      <KeybindingsSettingsPanel />
    </RegistryProvider>,
  );
  const whenTrigger = screen.getByRole("button", { name: "Edit when clause for Terminal: Toggle" });
  const expression = screen.getByRole("textbox", { name: "When expression" });

  await whenTrigger.click();
  await userEvent.type(expression, "terminalFocus");
  await userEvent.type(expression, " &&");
  await expect.element(screen.getByRole("button", { name: "Save" })).toBeDisabled();

  await userEvent.keyboard("{Escape}");
  await whenTrigger.click();

  await expect.element(expression).toHaveValue("terminalFocus");
  await expect.element(screen.getByRole("button", { name: "Save" })).toBeEnabled();
});
