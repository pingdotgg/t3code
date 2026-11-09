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

async function pressOnBody(init: KeyboardEventInit) {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  const event = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
  await act(() => document.body.dispatchEvent(event));
  return event;
}

it("opens search with the slash key on layouts where it is not '/'", async () => {
  await using _screen = await render(
    <SidebarProvider defaultOpen>
      <SettingsSidebarNav pathname="/settings/general" />
    </SidebarProvider>,
    { router: "/settings/general" },
  );
  const search = page.getByRole("combobox", { name: "Search settings" });

  // German Shift+7 types "/" on a key that is not the physical Slash key.
  const german = await pressOnBody({ key: "/", code: "Digit7", shiftKey: true });
  expect(german.defaultPrevented).toBe(true);
  await expect.element(search).toHaveFocus();

  // Russian and Ukrainian layouts type "." on the physical Slash key.
  const russian = await pressOnBody({ key: ".", code: "Slash" });
  expect(russian.defaultPrevented, "Slash key on a Russian layout").toBe(true);
  await expect.element(search).toHaveFocus();
});

it("opens search with Mod+F on non-Latin layouts", async () => {
  await using _screen = await render(
    <SidebarProvider defaultOpen>
      <SettingsSidebarNav pathname="/settings/general" />
    </SidebarProvider>,
    { router: "/settings/general" },
  );
  const search = page.getByRole("combobox", { name: "Search settings" });

  for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
    const event = await pressOnBody({ key: "а", code: "KeyF", ...modifier });
    expect(event.defaultPrevented, `Russian ${JSON.stringify(modifier)}+F`).toBe(true);
    await expect.element(search).toHaveFocus();
  }
});

it("ignores Shift on the slash key unless the layout types '/'", async () => {
  await using _screen = await render(
    <SidebarProvider defaultOpen>
      <SettingsSidebarNav pathname="/settings/general" />
    </SidebarProvider>,
    { router: "/settings/general" },
  );

  for (const init of [
    { key: "?", code: "Slash", shiftKey: true },
    { key: "7", code: "Digit7" },
  ]) {
    const event = await pressOnBody(init);
    expect(event.defaultPrevented, JSON.stringify(init)).toBe(false);
  }
});
