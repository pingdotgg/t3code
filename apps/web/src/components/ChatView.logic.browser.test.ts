import { createElement, Fragment } from "react";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { isCoveredByModal, shouldRefocusComposerOnWindowFocus } from "./ChatView.logic";
import { Dialog, DialogPopup, DialogTitle } from "./ui/dialog";

it("keeps keyboard focus on a sidebar row on window return, but not a clicked row", async () => {
  const list = document.createElement("ul");
  const row = (name: string) => {
    const element = document.createElement("div");
    element.setAttribute("role", "button");
    element.tabIndex = 0;
    element.dataset.sidebarRow = name;
    element.textContent = name;
    list.append(element);
    return element;
  };
  const clicked = row("Clicked thread");
  const tabbed = row("Tabbed thread");
  document.body.append(list);
  using _list = { [Symbol.dispose]: () => list.remove() };

  await userEvent.click(clicked);
  expect(document.activeElement).toBe(clicked);
  expect(shouldRefocusComposerOnWindowFocus(document.activeElement)).toBe(true);

  await userEvent.tab();
  expect(document.activeElement).toBe(tabbed);
  expect(shouldRefocusComposerOnWindowFocus(document.activeElement)).toBe(false);
});

it("treats a composer behind an open modal dialog as covered", async () => {
  const app = (open: boolean) =>
    createElement(
      Fragment,
      null,
      createElement("main", null, createElement("div", { "data-testid": "composer" })),
      createElement(
        Dialog,
        { open },
        createElement(DialogPopup, null, createElement(DialogTitle, null, "Tabs, side by side")),
      ),
    );
  await using screen = await render(app(true));
  await expect.element(page.getByRole("dialog")).toBeVisible();
  const composer = screen.getByTestId("composer").element();
  expect(isCoveredByModal(composer)).toBe(true);

  await screen.rerender(app(false));
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(isCoveredByModal(composer)).toBe(false);
});
