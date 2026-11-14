import "../index.css";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import * as settings from "../hooks/useSettings";
import { Command, CommandInput, CommandItem, CommandList } from "../components/ui/command";
import {
  Combobox,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "../components/ui/combobox";
import { Menu, MenuItem, MenuPopup, MenuSearchInput, MenuTrigger } from "../components/ui/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { registerCommands } from "./dispatcher";

vi.mock(import("../hooks/useSettings"), { spy: true });

it.each(["command", "combobox", "menu", "searchable menu", "select"] as const)(
  "navigates a %s with Ctrl+J/K through its arrow-key behavior",
  async (kind) => {
    const values = ["Alpha", "Disabled", "Beta"];
    const ui =
      kind === "command" ? (
        <Command>
          <CommandInput aria-label="Search" />
          <CommandList>
            {values.map((value) => (
              <CommandItem key={value} value={value} disabled={value === "Disabled"}>
                {value}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      ) : kind === "combobox" ? (
        <Combobox items={values} defaultOpen autoHighlight>
          <ComboboxInput aria-label="Search" />
          <ComboboxPopup>
            <ComboboxList>
              {values.map((value) => (
                <ComboboxItem key={value} value={value} disabled={value === "Disabled"}>
                  {value}
                </ComboboxItem>
              ))}
            </ComboboxList>
          </ComboboxPopup>
        </Combobox>
      ) : kind === "select" ? (
        <Select defaultOpen defaultValue="Alpha">
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {values.map((value) => (
              <SelectItem key={value} value={value} disabled={value === "Disabled"}>
                {value}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : (
        <Menu defaultOpen>
          <MenuTrigger>Open</MenuTrigger>
          <MenuPopup>
            {kind === "searchable menu" && <MenuSearchInput aria-label="Search" />}
            {values.map((value) => (
              <MenuItem key={value} disabled={value === "Disabled"}>
                {value}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      );
    await using _screen = await render(ui);
    using setting = vi.spyOn(settings, "getClientSettings").mockReturnValue({
      ...DEFAULT_CLIENT_SETTINGS,
      vimListNavigation: true,
    });
    using stack = new DisposableStack();
    const onCommand = vi.fn((event: KeyboardEvent) => event.preventDefault());
    const keybindings = compileResolvedKeybindingsConfig([
      { key: "ctrl+j", command: "terminal.toggle" },
      { key: "ctrl+k", command: "commandPalette.toggle" },
    ]);
    stack.defer(
      registerCommands(
        { "terminal.toggle": onCommand, "commandPalette.toggle": onCommand },
        { keybindings: () => keybindings },
      ),
    );
    const role = kind.includes("menu") ? "menuitem" : "option";
    const alpha = page.getByRole(role, { name: "Alpha", exact: true });
    await expect.element(alpha).toBeVisible();
    if (kind === "command" || kind === "combobox" || kind === "searchable menu") {
      await userEvent.click(
        page
          .getByRole("combobox", { name: "Search" })
          .or(page.getByRole("textbox", { name: "Search" })),
      );
      if (kind === "searchable menu") await userEvent.keyboard("{ArrowDown}");
    } else {
      (alpha.element() as HTMLElement).focus();
    }
    const highlighted = () =>
      document.querySelector(
        '[data-highlighted][role="option"], [data-highlighted][role="menuitem"]',
      )?.textContent;
    await userEvent.keyboard("{ArrowDown}");
    const down = highlighted();
    await userEvent.keyboard("{ArrowUp}");
    const up = highlighted();
    expect(down).toBeTruthy();
    expect(up).toBeTruthy();
    expect(down).not.toBe(up);
    await userEvent.keyboard("{Control>}j{/Control}");
    await vi.waitFor(() => expect(highlighted()).toBe(down));
    await userEvent.keyboard("{Control>}k{/Control}");
    await vi.waitFor(() => expect(highlighted()).toBe(up));
    expect(onCommand).not.toHaveBeenCalled();
    setting.mockReturnValue(DEFAULT_CLIENT_SETTINGS);
    await userEvent.keyboard("{Control>}j{/Control}");
    expect(onCommand).toHaveBeenCalledOnce();
  },
);
