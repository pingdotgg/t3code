import { page, userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { ProjectIconPickerDialog } from "./ProjectIconPickerDialog";

import "~/index.css";

vi.mock(import("@t3tools/shared/dashboardIcons"), async (importOriginal) => ({
  ...(await importOriginal()),
  dashboardIconUrl: (icon) =>
    icon.name === "plexamp"
      ? "http://127.0.0.1:9/plexamp.svg"
      : `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>')}`,
}));

it("Escape in the icon search clears it without closing the dialog", async () => {
  const onOpenChange = vi.fn();
  await using _screen = await render(
    <ProjectIconPickerDialog
      current={null}
      projectName="Project"
      open
      onOpenChange={onOpenChange}
      onSelect={() => {}}
    />,
  );
  const search = page.getByRole("searchbox", { name: "Search Lucide icons" });
  await expect.element(search).toHaveAttribute("type", "text");
  await userEvent.fill(search, "rocket");
  for (const composition of [
    { key: "Escape", isComposing: true, keyCode: 27 },
    { key: "Escape", isComposing: false, keyCode: 229 },
  ]) {
    // Safari ends the composition just before the Escape keydown.
    await act(() => {
      search.element().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      search
        .element()
        .dispatchEvent(new KeyboardEvent("keydown", { ...composition, bubbles: true }));
    });
    await expect.element(search).toHaveValue("rocket");
  }

  await userEvent.keyboard("{Escape}");
  await expect.element(search).toHaveValue("");
  await expect.element(search).toHaveFocus();
  // Holding Escape repeats the keydown, which must not also close the dialog.
  await act(() => {
    search
      .element()
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", repeat: true, bubbles: true }));
  });
  expect(onOpenChange).not.toHaveBeenCalled();

  await userEvent.keyboard("{Escape}");
  expect(onOpenChange.mock.calls.map(([open]) => open)).toEqual([false]);
});

it("suggests loadable dashboard icons from the project name and saves the pick", async () => {
  const catalog = {
    plex: { base: "svg", aliases: [], colors: { dark: "plex", light: "plex-light" } },
    plexamp: { base: "svg", aliases: [] },
  };
  const fetchMock = vi.fn(async () => Response.json(catalog));
  vi.stubGlobal("fetch", fetchMock);
  const onSelect = vi.fn();
  try {
    await using _screen = await render(
      <ProjectIconPickerDialog
        current={null}
        projectName="My Plex Server"
        open
        onOpenChange={() => {}}
        onSelect={onSelect}
      />,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    await userEvent.type(page.getByRole("searchbox"), "folder");
    await userEvent.click(page.getByRole("button", { name: "Logos" }));
    await expect.element(page.getByRole("button", { name: "plexamp" })).not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "plex" }));
    await userEvent.click(page.getByRole("button", { name: "Save icon" }));
    expect(onSelect).toHaveBeenCalledWith({
      kind: "dashboard-icon",
      name: "plex",
      file: "plex.svg",
      darkFile: "plex-light.svg",
    });
  } finally {
    vi.unstubAllGlobals();
  }
});
