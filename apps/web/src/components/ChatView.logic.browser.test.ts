import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { shouldRefocusComposerOnWindowFocus } from "./ChatView.logic";

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

it("keeps keyboard focus on a side-chat Map node on window return", async () => {
  const tree = document.createElement("div");
  tree.setAttribute("role", "tree");
  const node = document.createElement("button");
  node.setAttribute("role", "treeitem");
  node.textContent = "Side chat";
  tree.append(node);
  document.body.append(tree);
  using _tree = { [Symbol.dispose]: () => tree.remove() };

  await userEvent.tab();
  expect(document.activeElement).toBe(node);
  expect(shouldRefocusComposerOnWindowFocus(document.activeElement)).toBe(false);
});
