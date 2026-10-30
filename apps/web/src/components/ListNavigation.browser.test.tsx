import { compileResolvedKeybindingsConfig, DEFAULT_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { createRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";

const state = vi.hoisted(() => ({ navigate: vi.fn() }));

const keybindings = compileResolvedKeybindingsConfig([
  ...DEFAULT_KEYBINDINGS,
  { key: "ctrl+p", command: "list.previous", when: "listFocus" },
  { key: "ctrl+n", command: "list.next", when: "listFocus" },
]);

vi.mock(import("../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  return { ...(await original()), primaryServerKeybindingsAtom: Atom.make(() => keybindings) };
});
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => state.navigate) as never,
}));

import { registerListNavigationCommands } from "./AppSidebarLayout";
import { CommandPalette } from "./CommandPalette";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";
import { Combobox, ComboboxInput, ComboboxItem, ComboboxList, ComboboxPopup } from "./ui/combobox";

function setup() {
  state.navigate.mockClear();
}

function highlightedText(): string | null {
  return document.querySelector("[data-highlighted]")?.textContent ?? null;
}

describe("rebound list navigation", () => {
  // Linux, where Ctrl+N and Ctrl+P are also chat.new and filePicker.toggle.
  it("moves the command palette highlight without running other commands", async () => {
    setup();
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    using _commands = { [Symbol.dispose]: registerListNavigationCommands() };

    await userEvent.keyboard("{Control>}k{/Control}");
    await userEvent.keyboard("{Control>}n{/Control}{Control>}n{/Control}");
    await vi.waitFor(() => expect(highlightedText()).not.toBeNull());
    const second = highlightedText();

    await userEvent.keyboard("{Control>}p{/Control}");
    await vi.waitFor(() => expect(highlightedText()).not.toBe(second));

    await userEvent.keyboard("{ArrowDown}");
    await vi.waitFor(() => expect(highlightedText()).toBe(second));
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it("moves the combobox highlight", async () => {
    setup();
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    await using screen = await render(
      <Combobox items={["alpha", "beta", "gamma"]} open>
        <ComboboxInput aria-label="Pick" />
        <ComboboxPopup>
          <ComboboxList>
            {(item: string) => (
              <ComboboxItem key={item} value={item}>
                {item}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>,
    );
    using _commands = { [Symbol.dispose]: registerListNavigationCommands() };

    await userEvent.click(screen.getByRole("combobox", { name: "Pick" }));
    await userEvent.keyboard("{Control>}n{/Control}{Control>}n{/Control}");
    await vi.waitFor(() => expect(highlightedText()).toBe("beta"));

    await userEvent.keyboard("{Control>}p{/Control}");
    await vi.waitFor(() => expect(highlightedText()).toBe("alpha"));
  });

  it("reaches the composer only while its suggestion menu is open", async () => {
    setup();
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const onCommandKeyDown = vi.fn((_key: string, _event: KeyboardEvent) => false);
    const composer = (suggestionsOpen: boolean) => (
      <ComposerPromptEditor
        editorRef={createRef<ComposerPromptEditorHandle>()}
        value=""
        cursor={0}
        richTextEnabled={false}
        contextRecords={new Map()}
        skills={[]}
        disabled={false}
        placeholder=""
        ariaLabel="Message"
        suggestionListId="suggestions"
        suggestionsOpen={suggestionsOpen}
        onCommandKeyDown={onCommandKeyDown}
        onChange={() => {}}
        onPaste={() => {}}
      />
    );
    await using screen = await render(composer(false));
    using _commands = { [Symbol.dispose]: registerListNavigationCommands() };
    const arrowDowns = () => onCommandKeyDown.mock.calls.filter(([key]) => key === "ArrowDown");

    await userEvent.click(screen.getByRole("textbox", { name: "Message" }));
    await userEvent.keyboard("{Control>}n{/Control}");
    expect(arrowDowns()).toHaveLength(0);

    await screen.rerender(composer(true));
    await userEvent.keyboard("{Control>}n{/Control}");
    await vi.waitFor(() => expect(arrowDowns()).toHaveLength(1));
  });
});
