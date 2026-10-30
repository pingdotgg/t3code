import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { useCommandPaletteMount, useCommandPaletteStore } from "../commandPaletteStore";
import { installCommandPaletteCommands } from "./commandPaletteCommands";

const keybindings = compileResolvedKeybindingsConfig([
  { key: "mod+k", command: "commandPalette.toggle" },
]);

function MountedPalette() {
  useCommandPaletteMount();
  return null;
}

function setup() {
  useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
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

  it("open the palette while it is mounted, and it closes when it unmounts", async () => {
    setup();
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    await using screen = await render(<MountedPalette />, { router: "/" });
    using commands = new DisposableStack();
    commands.defer(
      installCommandPaletteCommands(screen.router!, { keybindings: () => keybindings }),
    );

    await userEvent.keyboard("{Control>}k{/Control}");
    expect(useCommandPaletteStore.getState().open).toBe(true);

    await screen.rerender(<div />);
    expect(useCommandPaletteStore.getState().open).toBe(false);
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
