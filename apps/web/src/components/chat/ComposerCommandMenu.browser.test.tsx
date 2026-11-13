import { expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { ComposerCommandMenu, type ComposerCommandItem } from "./ComposerCommandMenu";

const row = (
  id: string,
  label: string,
  extra: Partial<Extract<ComposerCommandItem, { type: "folder-destination" }>>,
): ComposerCommandItem => ({
  id,
  type: "folder-destination",
  group: "Folders",
  icon: "folder",
  label,
  description: `/repos/${label}`,
  isProject: false,
  action: { kind: "open", query: `/repos/${label}/` },
  ...extra,
});

it("shows the /cd pane with its folder, group labels, and a badge on a project root", async () => {
  const onSelect = vi.fn();
  const items = [
    row("p", "alpha", { group: "Projects", icon: "project", isProject: true }),
    row("root", "beta", { icon: "project", isProject: true }),
    row("docs", "docs", {}),
    row("current", "current", { icon: "project", isProject: true, isCurrent: true }),
  ];
  // router: false because the menu reads no route.
  await using screen = await render(
    <ComposerCommandMenu
      listId="destinations"
      items={items}
      resolvedTheme="dark"
      isLoading={false}
      triggerKind="folder"
      header="Working in /repos/current"
      activeItemId="docs"
      onHighlightedItemChange={() => {}}
      onSelect={onSelect}
    />,
    { router: false },
  );
  await expect.element(screen.getByText("Working in /repos/current")).toBeVisible();
  await expect.element(screen.getByRole("listbox", { name: "Destinations" })).toBeVisible();
  await expect.element(screen.getByText("Projects", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Folders", { exact: true })).toBeVisible();
  // Only the project root listed among the folders needs the badge; the thread's own folder,
  // a project root too, says that it is current instead.
  expect(screen.getByText("Project", { exact: true }).elements()).toHaveLength(1);
  expect(screen.getByText("Current", { exact: true }).elements()).toHaveLength(1);
  await expect
    .element(screen.getByRole("option", { name: /current/ }))
    .toHaveTextContent("current/repos/currentCurrent");
  const options = screen.getByRole("option").elements();
  expect(options.map((option) => option.getAttribute("aria-selected"))).toEqual([
    "false",
    "false",
    "true",
    "false",
  ]);
  await screen.getByRole("option", { name: /docs/ }).click();
  expect(onSelect).toHaveBeenCalledWith(items[2]);
});

it("shows a message below the parent row when a typed folder name matches nothing", async () => {
  const footer = "No folder at /repos/zzz.";
  await using screen = await render(
    <ComposerCommandMenu
      listId="destinations"
      items={[row("parent", "..", { icon: "parent" })]}
      resolvedTheme="dark"
      isLoading={false}
      triggerKind="folder"
      footer={footer}
      activeItemId={null}
      onHighlightedItemChange={() => {}}
      onSelect={() => {}}
    />,
    // router: false because the menu reads no route.
    { router: false },
  );
  await expect.element(screen.getByRole("option", { name: /\.\./ })).toBeVisible();
  await expect.element(screen.getByText(footer)).toBeVisible();
});

it("wraps the paths in the /cd pane's header and footer at their separators", async () => {
  const header =
    "Working in /Users/agents/.t3-dev/cd-ux/scratch/2026-11-09-remember-the-word-teapot-0e25d2ca";
  const footer = "No folder at /Users/agents/.t3-dev/cd-ux/scratch/2026-11-09-remember-the-word.";
  await using screen = await render(
    <ComposerCommandMenu
      listId="destinations"
      items={[row("parent", "..", { icon: "parent" })]}
      resolvedTheme="dark"
      isLoading={false}
      triggerKind="folder"
      header={header}
      footer={footer}
      activeItemId={null}
      onHighlightedItemChange={() => {}}
      onSelect={() => {}}
    />,
    // router: false because the menu reads no route.
    { router: false },
  );
  for (const text of [header, footer]) {
    const line = screen.getByText(text, { exact: true });
    await expect.element(line).toBeVisible();
    const style = getComputedStyle(line.element());
    expect([style.overflowWrap, style.wordBreak]).toEqual(["anywhere", "normal"]);
  }
});

it("says that folders are loading while the /cd pane has no rows yet", async () => {
  await using screen = await render(
    <ComposerCommandMenu
      listId="destinations"
      items={[]}
      resolvedTheme="dark"
      isLoading
      triggerKind="folder"
      activeItemId={null}
      onHighlightedItemChange={() => {}}
      onSelect={() => {}}
    />,
    // router: false because the menu reads no route.
    { router: false },
  );
  await expect.element(screen.getByText("Loading folders...")).toBeVisible();
});
