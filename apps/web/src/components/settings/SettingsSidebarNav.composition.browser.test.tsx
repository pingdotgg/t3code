import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { SettingsSidebarNav } from "./SettingsSidebarNav";

vi.mock("./useAvailableSettingsSearchItems", () => ({
  useAvailableSettingsSearchItems: () => [
    { id: "theme", title: "Theme", to: "/settings/appearance" },
  ],
}));

it("ignores composing keys in the search", async () => {
  await using screen = await render(
    <SidebarProvider defaultOpen>
      <SettingsSidebarNav pathname="/settings/general" />
    </SidebarProvider>,
    { router: "/settings/general" },
  );
  const search = page.getByRole("combobox", { name: "Search settings" });
  await search.fill("theme");
  await expect.element(page.getByRole("option", { name: /Theme/ })).toBeVisible();

  for (const composition of [
    { key: "Enter", isComposing: true, keyCode: 13 },
    { key: "Enter", isComposing: false, keyCode: 229 },
    { key: "Escape", isComposing: true, keyCode: 27 },
    { key: "Escape", isComposing: false, keyCode: 229 },
    { key: "ArrowDown", isComposing: true, keyCode: 40 },
    { key: "ArrowUp", isComposing: true, keyCode: 38 },
  ]) {
    const event = new KeyboardEvent("keydown", { ...composition, bubbles: true, cancelable: true });
    await act(() => search.element().dispatchEvent(event));
    expect(event.defaultPrevented, JSON.stringify(composition)).toBe(false);
    expect(screen.router?.state.location.pathname).toBe("/settings/general");
    await expect.element(search).toHaveValue("theme");
  }

  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe("/settings/appearance"),
  );
});

it("opens search from the physical Slash and F keys on non-US layouts", async () => {
  await using _screen = await render(
    <SidebarProvider defaultOpen>
      <SettingsSidebarNav pathname="/settings/general" />
    </SidebarProvider>,
    { router: "/settings/general" },
  );
  const search = page.getByRole("combobox", { name: "Search settings" });

  for (const { init, opens } of [
    { init: { key: "/", code: "Digit7", shiftKey: true }, opens: true }, // German Shift+7
    { init: { key: ".", code: "Slash" }, opens: true }, // Russian Slash key
    { init: { key: "а", code: "KeyF", ctrlKey: true }, opens: true }, // Russian Ctrl+F
    { init: { key: "?", code: "Slash", shiftKey: true }, opens: false },
  ]) {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const event = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
    await act(() => document.body.dispatchEvent(event));
    expect(event.defaultPrevented, JSON.stringify(init)).toBe(opens);
    if (opens) await expect.element(search).toHaveFocus();
  }
});
