import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import {
  dispatchCommandPalette,
  useCommandPaletteMount,
  useCommandPaletteStore,
} from "../commandPaletteStore";
import { useThemeEditorStore } from "../components/settings/themeEditorStore";
import { installCommandPaletteCommands } from "./commandPaletteCommands";

const keybindings = compileResolvedKeybindingsConfig([
  { key: "mod+k", command: "commandPalette.toggle" },
  { key: "mod+alt+shift+t", command: "themeEditor.toggle" },
  { key: "mod+u", command: "usage.open" },
]);

function MountedPalette() {
  useCommandPaletteMount();
  return null;
}

function setup() {
  useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
  useThemeEditorStore.setState(useThemeEditorStore.getInitialState(), true);
}

describe("command palette shortcuts", () => {
  it("stay inert on routes without the palette", async () => {
    setup();
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    await using screen = await render(null, { router: "/pair" });
    using commands = new DisposableStack();
    commands.defer(
      installCommandPaletteCommands(screen.router!, { keybindings: () => keybindings }),
    );

    await userEvent.keyboard("{Control>}k{/Control}");

    expect(useCommandPaletteStore.getState().open).toBe(false);
  });

  it("open the palette while it is mounted, keep it open on repeat, and it closes when it unmounts", async () => {
    setup();
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    await using screen = await render(<MountedPalette />, { router: "/" });
    using commands = new DisposableStack();
    commands.defer(
      installCommandPaletteCommands(screen.router!, { keybindings: () => keybindings }),
    );

    await userEvent.keyboard("{Control>}k{/Control}");
    expect(useCommandPaletteStore.getState().open).toBe(true);

    const repeatEvent = new KeyboardEvent("keydown", {
      key: "k",
      ctrlKey: true,
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(repeatEvent);
    expect(repeatEvent.defaultPrevented).toBe(true);
    expect(useCommandPaletteStore.getState().open).toBe(true);

    await screen.rerender(<div />);
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });

  it("keep a child search open on a composing Escape", async () => {
    setup();
    await using screen = await render(
      <>
        <MountedPalette />
        <input aria-label="Search files" />
      </>,
      { router: "/" },
    );
    using commands = new DisposableStack();
    commands.defer(
      installCommandPaletteCommands(screen.router!, { keybindings: () => keybindings }),
    );
    dispatchCommandPalette({ _tag: "ToggleMode", mode: "files" });
    const input = page.getByRole("textbox", { name: "Search files" });
    await input.fill("にほん");

    for (const composition of [
      { key: "Escape", isComposing: true, keyCode: 27 },
      { key: "Escape", isComposing: false, keyCode: 229 },
    ]) {
      const event = new KeyboardEvent("keydown", {
        ...composition,
        bubbles: true,
        cancelable: true,
      });
      input.element().dispatchEvent(event);
      expect(event.defaultPrevented, JSON.stringify(composition)).toBe(false);
      expect(useCommandPaletteStore.getState()).toMatchObject({ open: true, mode: "files" });
      await expect.element(input).toHaveValue("にほん");
      await expect.element(input).toHaveFocus();
    }

    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      keyCode: 27,
      bubbles: true,
      cancelable: true,
    });
    input.element().dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
  });

  it("keeps a child search open on a repeated Escape", async () => {
    setup();
    await using screen = await render(
      <>
        <MountedPalette />
        <input aria-label="Search files" />
      </>,
      { router: "/" },
    );
    using commands = new DisposableStack();
    commands.defer(
      installCommandPaletteCommands(screen.router!, { keybindings: () => keybindings }),
    );
    dispatchCommandPalette({ _tag: "ToggleMode", mode: "files" });
    const input = page.getByRole("textbox", { name: "Search files" });
    await input.click();

    const repeatEscape = new KeyboardEvent("keydown", {
      key: "Escape",
      keyCode: 27,
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    input.element().dispatchEvent(repeatEscape);
    expect(repeatEscape.defaultPrevented).toBe(true);
    expect(useCommandPaletteStore.getState()).toMatchObject({ open: true, mode: "files" });

    const freshEscape = new KeyboardEvent("keydown", {
      key: "Escape",
      keyCode: 27,
      repeat: false,
      bubbles: true,
      cancelable: true,
    });
    input.element().dispatchEvent(freshEscape);
    expect(freshEscape.defaultPrevented).toBe(true);
    expect(useCommandPaletteStore.getState()).toMatchObject({ open: true, mode: "command" });
  });

  it("keeps the theme editor open on a repeated themeEditor.toggle shortcut", async () => {
    setup();
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    await using screen = await render(<MountedPalette />, { router: "/" });
    using commands = new DisposableStack();
    commands.defer(
      installCommandPaletteCommands(screen.router!, { keybindings: () => keybindings }),
    );

    await userEvent.keyboard("{Control>}{Alt>}{Shift>}t{/Shift}{/Alt}{/Control}");
    const openedSession = useThemeEditorStore.getState().session;
    expect(openedSession).not.toBeNull();

    const repeatEvent = new KeyboardEvent("keydown", {
      key: "T",
      ctrlKey: true,
      altKey: true,
      shiftKey: true,
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(repeatEvent);
    expect(repeatEvent.defaultPrevented).toBe(true);
    expect(useThemeEditorStore.getState().session).toBe(openedSession);
  });

  it("open Usage once while its shortcut is held", async () => {
    setup();
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    await using screen = await render(<MountedPalette />, { router: "/" });
    using commands = new DisposableStack();
    commands.defer(
      installCommandPaletteCommands(screen.router!, { keybindings: () => keybindings }),
    );
    using navigate = vi.spyOn(screen.router!, "navigate").mockResolvedValue(undefined);

    await userEvent.keyboard("{Control>}u{/Control}");
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith({ to: "/usage" });

    const repeatEvent = new KeyboardEvent("keydown", {
      key: "u",
      ctrlKey: true,
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(repeatEvent);
    expect(repeatEvent.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledOnce();
  });
});

describe("openCommandPalette", () => {
  it("drops a request made while no palette is mounted", async () => {
    setup();
    await using screen = await render(null, { router: "/pair" });

    openCommandPalette({ open: "new-thread-in" });
    await screen.rerender(<MountedPalette />);
    expect(useCommandPaletteStore.getState()).toMatchObject({ open: false, openIntent: null });

    openCommandPalette({ open: "new-thread-in" });
    expect(useCommandPaletteStore.getState()).toMatchObject({
      open: true,
      openIntent: { kind: "new-thread-in" },
    });
  });
});
