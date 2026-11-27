import { RegistryProvider } from "@effect/atom-react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent, type Locator } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import * as atomCommands from "../../state/use-atom-command";

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
  useAtomCommand: vi.fn(() => runCommand) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => {
    const environment = {
      environmentId: "env",
      label: "Build workstation",
      serverConfig: {
        keybindings: compileResolvedKeybindingsConfig([
          { command: "composer.sendBackground", key: "mod+alt+enter", when: "false" },
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

  it.each([
    { name: "existing binding", field: existingField, open: () => activate(existingPill, "click") },
    {
      name: "new binding",
      field: newField,
      open: async () => {
        await activate(page.getByRole("button", { name: "Add keybinding" }), "click");
        await activate(newField, "focus");
      },
    },
  ])("records Shift+Esc in the $name field", async ({ field, open }) => {
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
    await userEvent.keyboard("{Shift>}{Escape}{/Shift}");

    await expect.element(field).toHaveValue("shift+esc");
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

it("unassigns a default shortcut and restores its condition when one is assigned again", async () => {
  const mutate = vi.fn(async () => ({ _tag: "Success", value: [] }));
  await vi.mocked(atomCommands.useAtomCommand).withImplementation(
    () => mutate as never,
    async () => {
      await using screen = await render(<KeybindingsSettingsPanel />);

      await screen.getByRole("button", { name: "Actions for Toggle sidebar" }).click();
      await screen.getByRole("menuitem", { name: "Unassign" }).click();
      expect(mutate).toHaveBeenLastCalledWith({
        environmentId: "env",
        input: {
          command: "sidebar.toggle",
          key: "mod+b",
          when: "false",
          replace: { command: "sidebar.toggle", key: "mod+b" },
        },
      });

      const unassigned = screen.getByRole("button", {
        name: "Edit shortcut for Start in background: Unassigned",
      });
      const save = screen.getByRole("button", { name: "Save" });
      await unassigned.click();
      await userEvent.keyboard("{Control>}{Alt>}j{/Alt}{/Control}");
      await expect.element(save).toBeVisible();
      await userEvent.keyboard("{Escape}");
      await expect.element(save).not.toBeInTheDocument();

      await unassigned.click();
      await userEvent.keyboard("{Control>}{Alt>}j{/Alt}{/Control}");
      await save.click();
      expect(mutate).toHaveBeenLastCalledWith({
        environmentId: "env",
        input: expect.objectContaining({
          command: "composer.sendBackground",
          when: "composerFocus && draftThreadRoute",
          replace: { command: "composer.sendBackground", key: "mod+alt+enter", when: "false" },
        }),
      });
    },
  );
});

it("Esc in the keybindings search clears the query without closing Settings", async () => {
  const onOpenChange = vi.fn();
  await using _screen = await render(
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogTitle>Settings</DialogTitle>
        <KeybindingsSettingsPanel />
      </DialogPopup>
    </Dialog>,
  );
  const search = page.getByRole("searchbox", { name: "Search keybindings" });
  await search.fill("sidebar");
  for (const composition of [
    { key: "Escape", isComposing: true, keyCode: 27 },
    { key: "Escape", isComposing: false, keyCode: 229 },
  ]) {
    const keydown = new KeyboardEvent("keydown", {
      ...composition,
      bubbles: true,
      cancelable: true,
    });
    await act(() => {
      // Safari ends the composition just before the Escape keydown.
      if (!composition.isComposing)
        search.element().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      search.element().dispatchEvent(keydown);
    });
    expect(keydown.defaultPrevented).toBe(false);
    await expect.element(search).toHaveValue("sidebar");
    await expect.element(search).toHaveFocus();
  }
  expect(search.element().getAttribute("type")).toBe("text");

  await userEvent.keyboard("{Escape}");
  await expect.element(search).toHaveValue("");
  await expect.element(search).toHaveFocus();

  await act(() =>
    search.element().dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        repeat: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  await expect.element(search).toHaveValue("");
  await expect.element(search).toHaveFocus();
  expect(onOpenChange).not.toHaveBeenCalled();

  await search.fill("sidebar");
  await userEvent.keyboard("{Shift>}{Escape}{/Shift}");
  await expect.element(search).toHaveValue("sidebar");
  await expect.element(search).toHaveFocus();
  expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything());
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
  await userEvent.keyboard("sidebar.toggle");
  await page.getByRole("option", { name: /Toggle sidebar/ }).click();
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

it("filters actions and allows additional shortcuts for assigned commands", async () => {
  await using screen = await render(<KeybindingsSettingsPanel />);
  await screen.getByRole("button", { name: "Add keybinding" }).click();
  const dialog = page.getByRole("dialog", { name: "Command", exact: true });
  const search = dialog.getByRole("combobox", { name: "Search", exact: true });
  await expect.element(search).toHaveFocus();
  await userEvent.keyboard("sidebar.toggle");
  const assigned = page.getByRole("option", { name: /Toggle sidebar/ });
  await expect.element(assigned).not.toHaveAttribute("aria-disabled", "true");
  await expect.element(assigned.element().querySelector("kbd")!).toBeVisible();
  expect(assigned.element().querySelectorAll('[data-slot="kbd"]')).toHaveLength(2);
  await vi.waitFor(() => expect(page.getByRole("option").elements()).toHaveLength(1));
  await assigned.click();
  const command = screen.getByRole("combobox", { name: "Command", exact: true });
  await expect.element(command).toHaveTextContent("Toggle sidebar");
  await command.click();
  await search.fill("tab.close");
  const multiShortcut = page.getByRole("option", { name: /Close tab/ });
  await expect.element(multiShortcut).toBeVisible();
  expect(multiShortcut.element().querySelectorAll('[data-slot="kbd-group"]')).toHaveLength(1);
  const extraBadge = multiShortcut.getByText("+1");
  await expect.element(extraBadge).toBeVisible();
  await userEvent.hover(extraBadge);
  await vi.waitFor(() => {
    const tooltip = document.querySelector('[data-slot="tooltip-popup"]');
    expect(tooltip).not.toBeNull();
    expect(tooltip?.querySelectorAll('[data-slot="kbd"]')).toHaveLength(2);
    expect(tooltip?.textContent).toContain("!terminalFocus");
  });
  await search.fill("opposite queue");
  await expect
    .element(page.getByRole("option", { name: /Send with the opposite queue or steer action/ }))
    .toBeVisible();
  await vi.waitFor(() => expect(page.getByRole("option").elements()).toHaveLength(1));
  await search.fill("no-such-action");
  await expect.element(page.getByText("No results found.")).toBeVisible();
  await search.fill("composer.cycleHost");
  const available = page.getByRole("option", { name: "Composer: Cycle Host" });
  await expect.element(available).not.toHaveAttribute("aria-disabled", "true");
  await available.click();
  await expect
    .element(screen.getByRole("combobox", { name: "Command", exact: true }))
    .toHaveTextContent("Composer: Cycle Host");
});

it.each([
  {
    name: "macOS",
    platform: "MacIntel",
    terminalPreviousMac: {
      ariaLabel: "Edit shortcut for Terminal: Previous: ⇧⌘[",
      keys: ["⇧", "⌘", "["],
    },
    terminalPreviousCtrl: {
      ariaLabel: "Edit shortcut for Terminal: Previous: ⌃⌥[",
      keys: ["⌃", "⌥", "["],
    },
    editQueued: {
      ariaLabel: "Edit shortcut for Edit last queued message: ⌥Up",
      keys: ["⌥", "Up"],
    },
    focusNext: { ariaLabel: "Edit shortcut for Focus next workspace area: F6", keys: ["F6"] },
  },
  {
    name: "Linux",
    platform: "Linux x86_64",
    terminalPreviousMac: {
      ariaLabel: "Edit shortcut for Terminal: Previous: Shift+Meta+[",
      keys: ["Shift", "Meta", "["],
    },
    terminalPreviousCtrl: {
      ariaLabel: "Edit shortcut for Terminal: Previous: Ctrl+Alt+[",
      keys: ["Ctrl", "Alt", "["],
    },
    editQueued: {
      ariaLabel: "Edit shortcut for Edit last queued message: Alt+Up",
      keys: ["Alt", "Up"],
    },
    focusNext: { ariaLabel: "Edit shortcut for Focus next workspace area: F6", keys: ["F6"] },
  },
])(
  "renders platform modifier symbols and formatted key labels in shortcut pills on $name",
  async ({ name, platform, terminalPreviousMac, terminalPreviousCtrl, editQueued, focusNext }) => {
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    await using screen = await render(<KeybindingsSettingsPanel />);
    // The list leaves out a binding whose condition cannot hold on this platform.
    const terminalPrevious = name === "macOS" ? terminalPreviousMac : terminalPreviousCtrl;

    for (const expected of [terminalPrevious, editQueued, focusNext]) {
      const button = screen.getByRole("button", { name: expected.ariaLabel, exact: true });
      await expect.element(button).toBeVisible();
      const kbdTexts = Array.from(
        button.element().querySelectorAll('[data-slot="kbd"]'),
        (el) => el.textContent,
      );
      expect(kbdTexts).toEqual(expected.keys);
    }
  },
);
