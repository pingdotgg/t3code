import { page, userEvent } from "vite-plus/test/browser";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  updateClientSettings,
} from "../hooks/useSettings";
import { AppSidebarLayout } from "./AppSidebarLayout";

vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig } = await import("@t3tools/shared/keybindings");
  const keybindings = compileResolvedKeybindingsConfig([
    { key: "mod+b", command: "sidebar.toggle", when: "!terminalFocus" },
  ]);
  return { ...actual, primaryServerKeybindingsAtom: Atom.make(keybindings) };
});
vi.mock("../env", () => ({ isElectron: true }));
vi.mock("./Sidebar", () => ({ default: () => null }));
vi.mock("./BackgroundThreadAnnouncer", () => ({ BackgroundThreadAnnouncer: () => null }));
vi.mock("./sidebar/SidebarChrome", () => ({ SidebarBrandWidthProbe: () => null }));
const storedSettings = vi.hoisted(() => ({ current: Promise.resolve<unknown>(null) }));

vi.mock("../localApi", () => ({
  ensureLocalApi: () => ({
    persistence: {
      getClientSettings: () => storedSettings.current,
      setClientSettings: async () => undefined,
    },
  }),
}));

function setup(historySwipeNavigation: boolean) {
  storedSettings.current = Promise.resolve(null);
  __resetClientSettingsPersistenceForTests();
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, historySwipeNavigation });
}

function wheel(deltaX: number) {
  window.dispatchEvent(new WheelEvent("wheel", { deltaX, clientY: 200 }));
}

describe("desktop history swipe navigation", () => {
  it.each(["back", "forward"] as const)(
    "disables %s swipes and can re-enable them without reloading",
    async (direction) => {
      setup(false);
      using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
      using _available = vi
        .spyOn(window.navigation, direction === "back" ? "canGoBack" : "canGoForward", "get")
        .mockReturnValue(true);
      await using screen = await render(<AppSidebarLayout>Thread</AppSidebarLayout>);
      using navigate = vi.spyOn(window.history, direction).mockImplementation(() => undefined);
      const deltaX = direction === "back" ? -140 : 140;

      await act(() => {
        wheel(deltaX);
        wheel(0);
      });
      expect(navigate).not.toHaveBeenCalled();
      await expect.element(screen.getByTestId("history-swipe-indicator")).not.toBeInTheDocument();

      await act(() => updateClientSettings({ historySwipeNavigation: true }));
      await act(() => wheel(deltaX));
      await expect.element(screen.getByTestId("history-swipe-indicator")).toBeInTheDocument();

      await act(() => updateClientSettings({ historySwipeNavigation: false }));
      await expect.element(screen.getByTestId("history-swipe-indicator")).not.toBeInTheDocument();
      await act(() => wheel(0));
      expect(navigate).not.toHaveBeenCalled();

      await act(() => updateClientSettings({ historySwipeNavigation: true }));
      await act(() => {
        wheel(deltaX);
        wheel(0);
      });
      expect(navigate).toHaveBeenCalledOnce();
    },
  );

  it("keeps swipes off until the saved settings load", async () => {
    const saved = Promise.withResolvers<unknown>();
    storedSettings.current = saved.promise;
    __resetClientSettingsPersistenceForTests();
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    using _available = vi.spyOn(window.navigation, "canGoBack", "get").mockReturnValue(true);
    await using _screen = await render(<AppSidebarLayout>Thread</AppSidebarLayout>);
    using navigate = vi.spyOn(window.history, "back").mockImplementation(() => undefined);

    await act(() => {
      wheel(-140);
      wheel(0);
    });
    expect(navigate).not.toHaveBeenCalled();

    saved.resolve({ historySwipeNavigation: false });
    await act(() => saved.promise);
    await act(() => {
      wheel(-140);
      wheel(0);
    });
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("sidebar toggle shortcut", () => {
  it("leaves the key to a focused terminal when its rule excludes terminalFocus", async () => {
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
  });
});
