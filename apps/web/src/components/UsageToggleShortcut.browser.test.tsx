import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";

const state = vi.hoisted(() => ({ navigate: vi.fn() }));

// One key toggles Usage: it opens Usage elsewhere and goes back from it.
const keybindings = compileResolvedKeybindingsConfig([
  { key: "mod+u", command: "navigation.back", when: "usagePageOpen" },
  { key: "mod+u", command: "usage.open", when: "!usagePageOpen" },
]);

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => keybindings) as never,
}));
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig: compile } = await import("@t3tools/shared/keybindings");
  // Factories are hoisted above the module's own constants.
  const compiled = compile([
    { key: "mod+u", command: "navigation.back", when: "usagePageOpen" },
    { key: "mod+u", command: "usage.open", when: "!usagePageOpen" },
  ]);
  return { ...actual, primaryServerKeybindingsAtom: Atom.make(compiled) };
});
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => state.navigate) as never,
}));

import { useCommandPaletteMount } from "../commandPaletteStore";
import { installCommandPaletteCommands } from "../shortcuts/commandPaletteCommands";
import { registerNavigationHistoryCommands } from "./AppSidebarLayout";

function MountedPalette() {
  useCommandPaletteMount();
  return null;
}

// regression: #21357
describe("usage toggle shortcut on Usage", () => {
  it("goes back", async () => {
    vi.clearAllMocks();
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    await using screen = await render(null, { router: "/usage" });
    using _commands = { [Symbol.dispose]: registerNavigationHistoryCommands(screen.router!) };

    using back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    await userEvent.keyboard("{Control>}u{/Control}");

    expect(back).toHaveBeenCalledOnce();
  });

  // Both listeners sit on window, so the palette must not claim the key whatever their order.
  it("does not reopen Usage from the command palette", async () => {
    vi.clearAllMocks();
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    await using screen = await render(<MountedPalette />, { router: "/usage" });
    using navigate = vi.spyOn(screen.router!, "navigate");
    using commands = new DisposableStack();
    commands.defer(
      installCommandPaletteCommands(screen.router!, { keybindings: () => keybindings }),
    );

    await userEvent.keyboard("{Control>}u{/Control}");

    expect(navigate).not.toHaveBeenCalled();
  });
});
