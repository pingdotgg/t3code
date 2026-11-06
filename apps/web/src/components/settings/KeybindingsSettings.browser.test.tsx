import { RegistryProvider } from "@effect/atom-react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent, type Locator } from "vite-plus/test/browser";

import { render } from "../../../test/render";

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
  useEnvironmentsWithScope: ((environments: ReadonlyArray<{ environmentId: string }>) =>
    new Set(environments.map(({ environmentId }) => environmentId))) as never,
  readEnvironmentScope: () => true,
}));
const { runCommand } = vi.hoisted(() => ({ runCommand: vi.fn() }));

function setup() {
  runCommand.mockReset();
}

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => runCommand) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => {
    const environment = {
      environmentId: "env",
      label: "Build workstation",
      serverConfig: { keybindings: [], keybindingsConfigPath: null, availableEditors: [] },
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

const existingField = page.getByRole("textbox", { name: "Keybinding for Toggle sidebar" });
const existingPill = page.getByRole("button", { name: /^Edit shortcut for Toggle sidebar:/ });
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
      open: async () => {
        await activate(page.getByRole("searchbox", { name: "Search keybindings" }), "focus");
        await userEvent.keyboard("Toggle sidebar");
        await activate(existingPill, "click");
      },
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
        await expect.element(newField).not.toBeInTheDocument();
        await expect.element(page.getByRole("button", { name: "Add keybinding" })).toHaveFocus();
      },
    },
  ])("leaves the $name field without closing Settings", async ({ field, open, expectReset }) => {
    setup();
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

it("re-enables Save when a When editor closes on an expression it could not parse", async () => {
  setup();
  await using screen = await render(
    <RegistryProvider>
      <KeybindingsSettingsPanel />
    </RegistryProvider>,
  );
  await userEvent.type(
    screen.getByRole("searchbox", { name: "Search keybindings" }),
    "Toggle terminal",
  );
  const whenTrigger = screen
    .getByRole("button", { name: "Edit when clause for Toggle terminal" })
    .first();
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

it("cancels a new binding from its Command picker before closing Settings", async () => {
  setup();
  const onOpenChange = vi.fn();
  await using _screen = await render(
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogTitle>Settings</DialogTitle>
        <KeybindingsSettingsPanel />
      </DialogPopup>
    </Dialog>,
  );
  await activate(page.getByRole("button", { name: "Add keybinding" }), "click");
  await expect.element(newField).toBeVisible();
  newField.element().closest('[role="row"]')!.querySelector<HTMLButtonElement>("button")!.focus();
  await userEvent.keyboard("{Escape}");
  expect(onOpenChange).not.toHaveBeenCalled();
  await expect.element(newField).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Add keybinding" })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything());
});

it("keeps a new binding open when Escape is pressed during its save", async () => {
  setup();
  let finishSave = () => {};
  const pendingSave = new Promise<{ _tag: "Success"; value: undefined }>((resolve) => {
    finishSave = () => resolve({ _tag: "Success", value: undefined });
  });
  runCommand.mockReturnValue(pendingSave);
  await using screen = await render(<KeybindingsSettingsPanel />);
  await screen.getByRole("button", { name: "Add keybinding" }).click();
  await screen.getByRole("combobox").click();
  await page.getByRole("option", { name: "Toggle sidebar", exact: true }).click();
  const field = screen.getByRole("textbox", { name: "Keybinding for Toggle sidebar", exact: true });
  await field.click();
  await userEvent.keyboard("{Control>}k{/Control}");
  await screen.getByRole("button", { name: "Save", exact: true }).click();
  await expect.element(screen.getByRole("button", { name: "Saving" })).toBeDisabled();
  await field.click();
  const input = field.element();
  await userEvent.keyboard("{Escape}");
  expect(input.isConnected).toBe(true);
  await expect.element(screen.getByRole("button", { name: "Add keybinding" })).toBeDisabled();
  finishSave();
  await expect.element(screen.getByRole("button", { name: "Add keybinding" })).toBeEnabled();
});
