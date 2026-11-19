import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";

vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig } = await import("@t3tools/shared/keybindings");
  const keybindings = compileResolvedKeybindingsConfig([
    { key: "mod+b", command: "sidebar.toggle", when: "!terminalFocus" },
  ]);
  return { ...actual, primaryServerKeybindingsAtom: Atom.make(keybindings) };
});
// The thread list needs live environments; the shortcut lives in the shell around it.
vi.mock(import("./Sidebar"), () => ({
  default: (() => (
    <div>
      <button type="button">Filter threads by environment or project</button>
    </div>
  )) as never,
}));

import { AppSidebarLayout } from "./AppSidebarLayout";

function setup() {
  localStorage.clear();
  return { [Symbol.dispose]: () => localStorage.clear() };
}

describe("sidebar toggle shortcut", () => {
  it("honors terminal focus and keeps collapsed thread access in the rail", async () => {
    using _storage = setup();
    await page.viewport(1280, 800);
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    await using screen = await render(
      <AppSidebarLayout>
        <div data-terminal-owner="drawer">
          <textarea aria-label="Terminal input" />
        </div>
        <button type="button">Outside</button>
      </AppSidebarLayout>,
    );
    const wrapper = screen.container.querySelector('[data-slot="sidebar-wrapper"]')!;

    await userEvent.click(screen.getByRole("textbox", { name: "Terminal input" }));
    await userEvent.keyboard("{Control>}b{/Control}");
    expect(wrapper.getAttribute("data-sidebar-state")).toBe("expanded");

    await userEvent.click(screen.getByRole("button", { name: "Outside" }));
    await userEvent.keyboard("{Control>}b{/Control}");
    await vi.waitFor(() => expect(wrapper.getAttribute("data-sidebar-state")).toBe("collapsed"));
    await userEvent.click(screen.getByRole("button", { name: "Threads", exact: true }));

    await vi.waitFor(() =>
      expect(document.querySelector<HTMLElement>("[data-session-drawer]")).not.toBeNull(),
    );
    await expect
      .element(
        screen.getByRole("button", {
          name: "Filter threads by environment or project",
        }),
      )
      .toBeInTheDocument();

    expect(document.querySelector('[aria-label="Toggle main sidebar"]')).not.toBeNull();
    expect(document.querySelector('[aria-label^="Environment:"]')).not.toBeNull();
    expect(
      document.querySelector('[data-sidebar-navigation-rail] [aria-label="Threads"]'),
    ).not.toBeNull();
  });
});
